import express from "express";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";

// =====================================
// 1. CONFIGURACIÓN INICIAL
// =====================================

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// 25 MB para poder recibir PDFs en base64
app.use(express.json({ limit: "25mb" }));
app.use(express.static("public"));

// =====================================
// 2. CONFIGURAR GEMINI
// =====================================

const apiKey = process.env.GEMINI_API_KEY;
const MODELO = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const MODELO_RESPALDO = process.env.GEMINI_FALLBACK_MODEL || "gemini-3.5-flash-lite";
const usarVertex = process.env.USE_VERTEXAI === "true";
const MAX_PDF_MB = 15;

console.log("=================================");
console.log("       SISTEMA HACKATON");
console.log("=================================");
console.log("¿API configurada?:", Boolean(apiKey));
console.log("Modelo principal:", MODELO);
console.log("Modelo de respaldo:", MODELO_RESPALDO);

if (!apiKey) {
    console.error("ERROR: No se encontró GEMINI_API_KEY en el archivo .env");
    process.exit(1);
}

const ai = new GoogleGenAI({
    apiKey,
    ...(usarVertex && { vertexai: true })
});

// =====================================
// 3. FUNCIONES DE APOYO
// =====================================

const ERRORES_TEMPORALES = [429, 500, 503, 504];
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Llama a Gemini con reintentos y, si sigue fallando, usa el modelo de respaldo
async function llamarGemini(peticion) {
    const modelos = [MODELO, MODELO_RESPALDO].filter((m, i, a) => m && a.indexOf(m) === i);
    let ultimoError;

    for (const modelo of modelos) {
        for (let intento = 1; intento <= 3; intento++) {
            try {
                const response = await ai.models.generateContent({ ...peticion, model: modelo });
                return { texto: response.text, modelo };
            } catch (error) {
                ultimoError = error;
                const codigo = error.status || error.code;
                if (!ERRORES_TEMPORALES.includes(codigo)) {
                    if (codigo === 404) break; // modelo no disponible: probar el siguiente
                    throw error;
                }
                console.warn(`Modelo ${modelo} ocupado (${codigo}). Intento ${intento} de 3...`);
                if (intento < 3) await esperar(1000 * 2 ** (intento - 1));
            }
        }
        console.warn("Cambiando al modelo de respaldo...");
    }
    throw ultimoError;
}

// Responde con un mensaje de error claro en español
function manejarError(res, error) {
    console.error("=================================");
    console.error("ERROR REAL DE GEMINI:");
    console.error(error);

    let codigo = error.status || error.code || 500;
    // Gemini responde 400 cuando la key es inválida: lo tratamos como 401
    if (/API[_ ]?key not valid|API_KEY_INVALID/i.test(error.message || "")) codigo = 401;
    const mensajes = {
        400: "La solicitud no es válida. Revisa lo que enviaste.",
        401: "La API key no es válida. Si es de Vertex AI, pon USE_VERTEXAI=true en .env.",
        403: "La API key no tiene permisos para este modelo.",
        404: "El modelo no está disponible. Cambia GEMINI_MODEL en .env.",
        429: "Se alcanzó el límite de solicitudes. Espera un momento.",
        503: "Gemini está saturado. Intenta de nuevo en unos segundos."
    };
    const status = Number.isInteger(codigo) && codigo >= 400 && codigo < 600 ? codigo : 500;

    return res.status(status).json({
        error: mensajes[codigo] || "Ocurrió un error al consultar a Gemini.",
        detalle: error.message || "Error desconocido",
        codigo
    });
}

// Convierte el historial del frontend al formato de Gemini
// Formato esperado: [{ role: "user" | "model", text: "..." }]
function prepararHistorial(historial) {
    if (!Array.isArray(historial)) return [];
    return historial
        .filter((m) => m && (m.role === "user" || m.role === "model") && typeof m.text === "string" && m.text.trim())
        .slice(-20)
        .map((m) => ({ role: m.role, parts: [{ text: m.text }] }));
}

const textoValido = (t) => typeof t === "string" && t.trim().length > 0;

// Prepara el artículo (PDF o texto pegado) como parte del mensaje para Gemini
function prepararArticulo({ pdfBase64, texto }) {
    if (textoValido(pdfBase64)) {
        const mb = (pdfBase64.length * 3) / 4 / (1024 * 1024);
        if (mb > MAX_PDF_MB) {
            throw Object.assign(new Error(`El PDF pesa ${mb.toFixed(1)} MB. El máximo es ${MAX_PDF_MB} MB.`), { esDelUsuario: true });
        }
        return { inlineData: { mimeType: "application/pdf", data: pdfBase64 } };
    }
    if (textoValido(texto)) {
        if (texto.length < 200) {
            throw Object.assign(new Error("El texto es muy corto. Pega el artículo completo o sube el PDF."), { esDelUsuario: true });
        }
        return { text: "ARTÍCULO:\n\n" + texto.slice(0, 400000) };
    }
    throw Object.assign(new Error("Sube un PDF o pega el texto del artículo."), { esDelUsuario: true });
}

// Lee JSON aunque Gemini lo envuelva en ```json ... ```
function leerJSON(texto) {
    try {
        return JSON.parse(texto);
    } catch {
        const limpio = texto.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
        return JSON.parse(limpio);
    }
}

// =====================================
// 4. ESTADO DEL SERVIDOR
// =====================================

app.get("/api/status", (req, res) => {
    res.json({
        mensaje: "Servidor Hackaton funcionando correctamente",
        apiConfigurada: Boolean(apiKey),
        modelo: MODELO,
        modulos: ["consejos", "resumir", "crear"],
        analisisExtra: Object.keys(analisisExtra)
    });
});

// =====================================
// 5. MÓDULO 1: COACH DE CONSEJOS PERSONALIZADOS
// =====================================

const temas = {
    estudio: "hábitos de estudio, organización del tiempo y técnicas de aprendizaje basadas en evidencia",
    finanzas: "finanzas personales para jóvenes: presupuesto, ahorro, deudas y control de gastos",
    salud: "hábitos saludables: sueño, alimentación general, actividad física e hidratación",
    carrera: "orientación vocacional, desarrollo profesional, CV, entrevistas y primer empleo",
    bienestar: "bienestar personal, manejo del estrés, productividad y equilibrio de vida"
};

// Describe el perfil (y su progreso) para las instrucciones de Gemini
function describirPerfil(perfil = {}) {
    const datos = [
        perfil.nombre && `Nombre: ${perfil.nombre}`,
        perfil.edad && `Edad: ${perfil.edad}`,
        perfil.ocupacion && `Ocupación: ${perfil.ocupacion}`,
        perfil.objetivo && `Objetivo: ${perfil.objetivo}`,
        perfil.situacion && `Situación actual: ${perfil.situacion}`,
        perfil.tiempo && `Tiempo disponible: ${perfil.tiempo}`,
        perfil.obstaculo && `Principal obstáculo: ${perfil.obstaculo}`,
        perfil.estilo && `Prefiere consejos: ${perfil.estilo}`
    ].filter(Boolean).map((l) => String(l).slice(0, 600));
    return datos.join("\n") || "El usuario no compartió datos de perfil.";
}

function instruccionesCoach(perfil = {}, progreso = null) {
    const tema = temas[perfil.tema] || "cualquier tema de la vida diaria";
    let textoProgreso = "";
    if (progreso && Array.isArray(progreso.plan) && progreso.plan.length) {
        textoProgreso = "\nPLAN DE ACCIÓN DEL USUARIO (✅ = completado):\n" + progreso.plan
            .slice(0, 15)
            .map((p, i) => `${progreso.completados?.includes(i) ? "✅" : "⬜"} ${i + 1}. ${String(p).slice(0, 200)}`)
            .join("\n");
    }
    return `
Eres un coach personal certificado, experto en ${tema}.
Responde siempre en español, con tono cercano, motivador y muy práctico.

PERFIL DEL USUARIO:
${describirPerfil(perfil)}
${textoProgreso}

REGLAS:
- Personaliza todo con el perfil: usa su nombre, su edad, su tiempo disponible y su obstáculo principal.
- Da consejos concretos y accionables (qué hacer, cuándo y cómo), en pasos o listas cortas.
- Basa tus recomendaciones en técnicas reconocidas y menciona su nombre (ej. Pomodoro, regla 50/30/20, higiene del sueño).
- Si el usuario tiene un plan, conecta tus respuestas con sus pasos y celebra lo que ya completó.
- Si te falta información importante, haz una sola pregunta breve.
- No des diagnósticos médicos ni psicológicos, ni recomendaciones de inversión específicas.
  Si el tema es serio (salud, crisis emocional, deudas graves), recomienda con claridad acudir a un profesional.
`;
}

// Diagnóstico inicial y plan de acción (JSON)
app.post("/api/diagnostico", async (req, res) => {
    try {
        const { perfil = {} } = req.body;
        if (!textoValido(perfil.objetivo) && !textoValido(perfil.situacion)) {
            return res.status(400).json({ error: "Escribe tu objetivo o tu situación para poder ayudarte." });
        }

        const prompt = `
Con base en el perfil, crea un DIAGNÓSTICO y un PLAN DE ACCIÓN personalizado.
Responde SOLO con un JSON válido con esta estructura exacta:

{
  "saludo": "saludo breve y motivador usando su nombre",
  "resumenSituacion": "2 a 3 oraciones que muestren que entendiste su situación",
  "fortalezas": ["fortaleza que tiene según su perfil"],
  "obstaculos": [{ "obstaculo": "obstáculo concreto", "solucion": "cómo superarlo" }],
  "meta": { "smart": "meta SMART (específica, medible, alcanzable, relevante y con fecha)", "plazo": "ej. 8 semanas" },
  "plan": [
    { "paso": "acción concreta", "detalle": "cómo hacerlo exactamente", "plazo": "Semana 1", "dificultad": "fácil | media | difícil", "porque": "por qué este paso ayuda" }
  ],
  "habitos": [{ "habito": "hábito diario o semanal", "frecuencia": "diario | 3 veces por semana | ...", "momento": "cuándo hacerlo", "tip": "truco para no fallar" }],
  "metricas": [{ "indicador": "qué medir", "como": "cómo medirlo", "objetivo": "valor a alcanzar" }],
  "tecnicas": [{ "nombre": "técnica reconocida", "descripcion": "en qué consiste y cómo aplicarla en su caso" }],
  "recursos": ["recurso, app o herramienta gratuita útil"],
  "alerta": "si el caso requiere un profesional (médico, psicólogo, asesor), explícalo aquí; si no, deja cadena vacía"
}

Reglas: entre 6 y 10 pasos ordenados de lo más fácil a lo más difícil, adaptados a su tiempo disponible;
entre 3 y 5 hábitos, 3 métricas y 3 técnicas. Nada genérico: todo debe usar los datos del perfil.
`;

        console.log("=================================");
        console.log("DIAGNÓSTICO:", perfil.tema);

        const { texto, modelo } = await llamarGemini({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: {
                systemInstruction: instruccionesCoach(perfil),
                responseMimeType: "application/json",
                temperature: 0.6
            }
        });

        let diagnostico;
        try {
            diagnostico = leerJSON(texto);
        } catch {
            return res.status(502).json({ error: "No se pudo leer el diagnóstico. Intenta de nuevo." });
        }
        return res.json({ diagnostico, modelo });
    } catch (error) {
        return manejarError(res, error);
    }
});

// Chat con el coach (conoce el plan y el progreso)
app.post("/api/consejo", async (req, res) => {
    try {
        const { message, history = [], perfil = {}, progreso = null } = req.body;

        if (!textoValido(message)) {
            return res.status(400).json({ error: "Debes escribir un mensaje válido." });
        }

        const { texto, modelo } = await llamarGemini({
            contents: [...prepararHistorial(history), { role: "user", parts: [{ text: message.trim() }] }],
            config: { systemInstruction: instruccionesCoach(perfil, progreso) }
        });

        if (!texto) return res.status(502).json({ error: "Gemini no devolvió respuesta. Intenta de nuevo." });

        console.log("CONSEJO GENERADO (", modelo, ")");
        return res.json({ respuesta: texto, modelo });
    } catch (error) {
        return manejarError(res, error);
    }
});

// Herramientas especializadas del coach
const herramientasCoach = {
    rutina: {
        titulo: "Rutina semanal",
        prompt: "Diseña una rutina semanal realista (lunes a domingo) adaptada a su tiempo disponible y su objetivo. Preséntala como tabla markdown con columnas: Día | Mañana | Tarde | Noche. Después explica en 3 puntos por qué está organizada así y cómo ajustarla si un día falla."
    },
    obstaculos: {
        titulo: "Plan B contra obstáculos",
        prompt: "Identifica los 6 obstáculos más probables para que esta persona abandone su objetivo. Para cada uno escribe una estrategia 'Si pasa X, entonces haré Y' (intenciones de implementación). Termina con una tabla markdown: Obstáculo | Señal de alerta | Plan B."
    },
    reto: {
        titulo: "Reto de 30 días",
        prompt: "Crea un reto de 30 días dividido en 4 semanas que aumente de dificultad. Para cada día una micro-acción de máximo 20 minutos. Usa títulos por semana y una lista numerada por día. Agrega una recompensa al final de cada semana."
    },
    errores: {
        titulo: "Errores que debes evitar",
        prompt: "Lista los 7 errores más comunes que comete alguien con este perfil al intentar este objetivo. Para cada uno: por qué ocurre, cómo detectarlo y qué hacer en su lugar."
    },
    motivacion: {
        titulo: "Carta de motivación",
        prompt: "Escribe una carta motivadora y personal para esta persona, desde su 'yo del futuro' que ya logró la meta. Menciona sus obstáculos reales y cómo los superó. Termina con 5 frases cortas para leer cuando quiera rendirse."
    }
};

app.post("/api/consejo-extra", async (req, res) => {
    try {
        const { perfil = {}, tipo, progreso = null } = req.body;
        if (!Object.hasOwn(herramientasCoach, tipo)) {
            return res.status(400).json({ error: "Esa herramienta no existe." });
        }

        console.log("HERRAMIENTA COACH:", tipo);
        const { texto, modelo } = await llamarGemini({
            contents: [{ role: "user", parts: [{ text: herramientasCoach[tipo].prompt + "\nUsa títulos con ### y listas con guiones." }] }],
            config: { systemInstruction: instruccionesCoach(perfil, progreso), temperature: 0.7 }
        });

        if (!texto) return res.status(502).json({ error: "Gemini no devolvió respuesta. Intenta de nuevo." });
        return res.json({ titulo: herramientasCoach[tipo].titulo, resultado: texto, modelo });
    } catch (error) {
        return manejarError(res, error);
    }
});

// =====================================
// 6. MÓDULO 2: ANÁLISIS PROFUNDO DE ARTÍCULOS
// =====================================

const niveles = {
    experto: "un investigador del área (lenguaje técnico)",
    estudiante: "un estudiante universitario (claro, sin perder precisión)",
    principiante: "un adolescente de 15 años sin conocimientos previos (muy sencillo, con analogías)"
};

const INSTRUCCION_ANALISTA = `
Eres un investigador senior y revisor de revistas científicas (peer reviewer) con experiencia
en metodología de la investigación, estadística y evaluación crítica de evidencia.
Reglas:
- Respondes siempre en español, aunque el artículo esté en otro idioma.
- Te basas SOLO en el contenido del artículo. Nunca inventas datos, cifras, autores ni resultados.
- Si algo no aparece en el artículo, escribes exactamente "No especificado en el artículo".
- Cuando des un dato o hallazgo, indica dónde aparece (página, sección, tabla o figura) si es posible.
- Distingue claramente entre lo que dicen los autores y tu evaluación como revisor.
`;

app.post("/api/resumir", async (req, res) => {
    try {
        const { pdfBase64, texto, nivel = "estudiante", contexto = "" } = req.body;

        let articulo;
        try {
            articulo = prepararArticulo({ pdfBase64, texto });
        } catch (e) {
            if (e.esDelUsuario) return res.status(400).json({ error: e.message });
            throw e;
        }

        const lector = niveles[nivel] || niveles.estudiante;
        const usoLector = textoValido(contexto)
            ? `El lector quiere usar este artículo para: "${contexto.slice(0, 500)}". Úsalo en "aplicaciones".`
            : "El lector no indicó para qué lo usará; da aplicaciones generales.";

        const prompt = `
Realiza un ANÁLISIS PROFUNDO del artículo de investigación adjunto, como lo haría un revisor experto.
${usoLector}

Responde SOLO con un JSON válido (sin texto antes ni después) con esta estructura exacta:

{
  "ficha": {
    "titulo": "título completo",
    "autores": "autores principales",
    "anio": "año de publicación",
    "fuente": "revista, congreso o repositorio",
    "area": "área del conocimiento",
    "tipoEstudio": "experimental | cuasi-experimental | observacional | revisión sistemática | metaanálisis | estudio de caso | teórico | computacional | otro (especifica)",
    "palabrasClave": ["palabra 1", "palabra 2"]
  },
  "resumenEjecutivo": "4 a 6 oraciones: qué se investigó, cómo, qué se encontró y por qué importa",
  "contexto": {
    "antecedentes": "qué se sabía antes de este estudio",
    "problema": "problema concreto que aborda",
    "brecha": "qué hueco del conocimiento intenta llenar",
    "justificacion": "por qué es importante resolverlo"
  },
  "objetivos": {
    "general": "objetivo general",
    "especificos": ["objetivo específico 1", "objetivo específico 2"],
    "preguntas": ["pregunta de investigación 1"],
    "hipotesis": ["hipótesis 1 (o 'No especificado en el artículo')"]
  },
  "metodologia": {
    "enfoque": "cuantitativo | cualitativo | mixto",
    "diseno": "diseño de investigación explicado",
    "muestra": "población, tamaño de muestra y cómo se seleccionó",
    "variables": [{ "nombre": "variable", "tipo": "independiente | dependiente | control | otra", "descripcion": "cómo se midió" }],
    "instrumentos": "instrumentos, materiales, datasets, equipos o software utilizados",
    "procedimiento": ["paso 1 del procedimiento", "paso 2"],
    "analisisDatos": "técnicas estadísticas o de análisis utilizadas"
  },
  "resultados": [
    { "hallazgo": "resultado principal explicado", "evidencia": "cifras, porcentajes, p-valores o datos concretos que lo respaldan", "ubicacion": "página, tabla o figura" }
  ],
  "discusion": "cómo interpretan los autores sus resultados y cómo los comparan con estudios previos",
  "conclusiones": ["conclusión 1", "conclusión 2"],
  "contribuciones": ["aporte original 1 al campo"],
  "limitacionesAutores": ["limitación que reconocen los propios autores"],
  "trabajoFuturo": ["línea de investigación futura que proponen"],
  "analisisCritico": {
    "fortalezas": ["fortaleza 1"],
    "debilidades": ["debilidad metodológica o de argumentación 1"],
    "sesgos": ["posible sesgo 1 y por qué"],
    "validezInterna": "qué tan seguro es que los resultados se deben a lo que dicen (control de variables, diseño)",
    "validezExterna": "qué tanto se pueden generalizar los resultados",
    "reproducibilidad": "si hay datos, código o detalle suficiente para replicarlo",
    "coherencia": "si las conclusiones se desprenden realmente de los resultados o van más allá",
    "nivelEvidencia": "alto | moderado | bajo, con justificación breve",
    "calificaciones": {
      "rigorMetodologico": 0,
      "solidezEvidencia": 0,
      "claridad": 0,
      "originalidad": 0,
      "relevancia": 0
    },
    "veredicto": "evaluación final del revisor en 2 a 3 oraciones"
  },
  "conceptosClave": [{ "termino": "concepto", "definicion": "explicación breve" }],
  "explicacionSencilla": "explicación completa para ${lector}",
  "aplicaciones": ["aplicación práctica 1"],
  "preguntasSugeridas": ["pregunta interesante 1 que el lector podría hacerle al artículo", "pregunta 2", "pregunta 3", "pregunta 4"]
}

Reglas del JSON:
- "calificaciones": números enteros del 1 al 10, justificados por tu análisis crítico (no pongas todo alto por cortesía).
- Entre 3 y 8 resultados, con evidencia numérica cuando exista.
- Entre 4 y 8 conceptos clave.
- Sé específico: menciona cifras, nombres de métodos y detalles reales del artículo, no frases genéricas.
`;

        console.log("=================================");
        console.log("ANÁLISIS PROFUNDO (", pdfBase64 ? "PDF" : "texto", ")");

        const { texto: respuesta, modelo } = await llamarGemini({
            contents: [{ role: "user", parts: [articulo, { text: prompt }] }],
            config: {
                responseMimeType: "application/json",
                systemInstruction: INSTRUCCION_ANALISTA,
                temperature: 0.3
            }
        });

        let analisis;
        try {
            analisis = leerJSON(respuesta);
        } catch {
            console.error("Respuesta no era JSON:", respuesta?.slice(0, 500));
            return res.status(502).json({ error: "No se pudo leer el análisis. Intenta de nuevo." });
        }

        console.log("ANÁLISIS GENERADO (", modelo, ")");
        return res.json({ analisis, modelo });
    } catch (error) {
        return manejarError(res, error);
    }
});

// Análisis especializados bajo demanda
const analisisExtra = {
    estadistico: {
        titulo: "Análisis estadístico",
        prompt: `Haz un análisis estadístico detallado del artículo:
1. Lista cada prueba o técnica estadística usada y para qué se usó.
2. Reporta los valores clave (medias, desviaciones, p-valores, intervalos de confianza, tamaños de efecto, métricas de desempeño) con su ubicación.
3. Evalúa si las pruebas son adecuadas para el tipo de datos y el diseño.
4. Señala si el tamaño de muestra es suficiente (poder estadístico).
5. Distingue significancia estadística de relevancia práctica.
6. Señala errores o malas prácticas (p-hacking, comparaciones múltiples sin corrección, etc.) si los hay.
Si el artículo no es cuantitativo, explica cómo analizaron sus datos y evalúa ese análisis.`
    },
    sesgos: {
        titulo: "Detector de sesgos",
        prompt: `Evalúa a fondo los posibles sesgos del estudio. Para cada uno indica: qué es, evidencia en el artículo, qué tan grave es (alto/medio/bajo) y cómo afecta las conclusiones.
Revisa: sesgo de selección, de medición, de confusión, de publicación, de confirmación, de financiamiento y conflictos de interés, sesgo en los datos (si es IA/computacional), y sobre-generalización.
Termina con una tabla resumen.`
    },
    replicacion: {
        titulo: "Guía para replicar el estudio",
        prompt: `Escribe una guía paso a paso para que un estudiante pueda replicar este estudio:
materiales, datos o datasets necesarios, herramientas o software, procedimiento detallado, análisis de datos, resultados esperados para comparar,
y qué información FALTA en el artículo para poder replicarlo con exactitud. Indica la dificultad estimada (baja/media/alta) y el tiempo aproximado.`
    },
    debate: {
        titulo: "Debate: a favor y en contra",
        prompt: `Actúa como dos revisores que debaten sobre el artículo.
"A FAVOR": los 4 argumentos más fuertes de que el estudio es sólido e importante.
"EN CONTRA": las 4 críticas más fuertes que haría un revisor escéptico.
Para cada argumento cita la evidencia del artículo. Termina con una "Respuesta de los autores" probable a cada crítica y un veredicto equilibrado.`
    },
    estudio: {
        titulo: "Guía de estudio",
        prompt: `Crea una guía para estudiar el artículo:
1. Mapa de ideas: idea central y sus ramas principales (en formato de esquema con sangrías).
2. 8 preguntas de examen de opción múltiple (4 opciones, marca la correcta y explica por qué).
3. 4 preguntas abiertas de análisis con una respuesta modelo.
4. Los 5 datos que hay que recordar sí o sí.`
    },
    futuro: {
        titulo: "Ideas de investigación futura",
        prompt: `Propón 5 ideas concretas de investigación que surjan de este artículo (ideal para tesis o proyectos).
Para cada una: título tentativo, pregunta de investigación, qué hueco del artículo atiende, metodología sugerida, y nivel (licenciatura/maestría/doctorado).`
    },
    citas: {
        titulo: "Cómo citarlo",
        prompt: `Genera la referencia del artículo en formato APA 7, IEEE, MLA 9 y Chicago, con los datos que aparecen en el artículo.
Si falta algún dato (DOI, volumen, páginas), escribe [FALTA: dato] en su lugar, no lo inventes.
Agrega también un ejemplo de cita en el texto (parafraseada y textual) en APA 7.`
    }
};

app.post("/api/analisis-extra", async (req, res) => {
    try {
        const { pdfBase64, texto, tipo } = req.body;

        if (!Object.hasOwn(analisisExtra, tipo)) {
            return res.status(400).json({ error: "Ese tipo de análisis no existe." });
        }

        let articulo;
        try {
            articulo = prepararArticulo({ pdfBase64, texto });
        } catch (e) {
            if (e.esDelUsuario) return res.status(400).json({ error: e.message });
            throw e;
        }

        console.log("=================================");
        console.log("ANÁLISIS EXTRA:", tipo);

        const { texto: respuesta, modelo } = await llamarGemini({
            contents: [{ role: "user", parts: [articulo, { text: analisisExtra[tipo].prompt + "\nUsa títulos con ### y listas con guiones para que sea fácil de leer." }] }],
            config: { systemInstruction: INSTRUCCION_ANALISTA, temperature: 0.4 }
        });

        if (!respuesta) return res.status(502).json({ error: "Gemini no devolvió el análisis. Intenta de nuevo." });

        return res.json({ titulo: analisisExtra[tipo].titulo, resultado: respuesta, modelo });
    } catch (error) {
        return manejarError(res, error);
    }
});

// Preguntas sobre el artículo ya cargado
app.post("/api/preguntar", async (req, res) => {
    try {
        const { pdfBase64, texto, pregunta, history = [] } = req.body;

        if (!textoValido(pregunta)) {
            return res.status(400).json({ error: "Escribe una pregunta." });
        }

        let articulo;
        try {
            articulo = prepararArticulo({ pdfBase64, texto });
        } catch (e) {
            if (e.esDelUsuario) return res.status(400).json({ error: e.message });
            throw e;
        }

        const contents = [
            { role: "user", parts: [articulo, { text: "Este es el artículo que vamos a analizar." }] },
            { role: "model", parts: [{ text: "Entendido. Ya leí el artículo. ¿Qué quieres saber?" }] },
            ...prepararHistorial(history),
            { role: "user", parts: [{ text: pregunta.trim() }] }
        ];

        const { texto: respuesta, modelo } = await llamarGemini({
            contents,
            config: {
                systemInstruction: `
Eres un investigador experto que responde preguntas sobre un artículo de investigación.
Responde en español, de forma clara y bien organizada.
Básate SOLO en el artículo. Si la respuesta no está en el artículo, dilo claramente
y, si aplica, separa lo que dice el artículo de tu conocimiento general, marcándolo como tal.
Siempre indica dónde está la información (página, sección, tabla o figura), por ejemplo: (pág. 4, Tabla 2).
`
            }
        });

        return res.json({ respuesta: respuesta || "No obtuve respuesta. Intenta de nuevo.", modelo });
    } catch (error) {
        return manejarError(res, error);
    }
});

// =====================================
// 7. MÓDULO 3: ESTUDIO CREATIVO
// =====================================

// Cada tipo tiene un rol experto y una estructura obligatoria
const tiposCreativos = {
    codigo: {
        rol: "Eres un ingeniero de software senior y buen maestro.",
        estructura: `Estructura obligatoria:
### 📋 Qué hace
### 💻 Código
(código completo y funcional en un solo bloque \`\`\` con el lenguaje indicado; comentarios en español)
### ▶️ Cómo ejecutarlo
### 🧠 Cómo funciona (explicación por partes)
### 🧪 Casos de prueba (entradas y salidas esperadas)
### 🚀 Mejoras posibles
Si el lenguaje es HTML/CSS/JavaScript para navegador, entrega UN solo archivo HTML completo con <style> y <script> dentro.`
    },
    guion: {
        rol: "Eres guionista profesional de video para redes sociales y YouTube.",
        estructura: `Estructura obligatoria:
### 🎬 Ficha (título, plataforma, duración, público, objetivo)
### 🪝 Gancho (primeros 3 segundos)
### 🗂️ Escaleta (tabla markdown: Escena | Tiempo | Visual | Audio/Narración)
### 📝 Guion completo (con indicaciones de cámara entre corchetes)
### 🎵 Música y edición sugeridas
### 📣 Llamado a la acción y texto para la descripción`
    },
    cancion: {
        rol: "Eres compositor y productor musical.",
        estructura: `Estructura obligatoria:
### 🎵 Ficha (título, género, tempo en BPM, tonalidad, ánimo)
### 🎸 Progresión de acordes (para verso, coro y puente)
### 📝 Letra completa (marca [Intro], [Verso 1], [Pre-coro], [Coro], [Verso 2], [Puente], [Coro final]; escribe los acordes entre corchetes sobre las sílabas, ej. [Am]palabra)
### 🎚️ Notas de producción (instrumentos, ritmo, dinámica)
### 💡 Por qué funciona (rima, métrica, gancho)`
    },
    historia: {
        rol: "Eres escritor de ficción premiado.",
        estructura: `Estructura obligatoria:
### 📖 Ficha (título, género, público, logline de una oración)
### 👥 Personajes (nombre, rasgo principal, deseo, conflicto)
### ✍️ Historia completa (con inicio, nudo, clímax y desenlace; diálogos con raya —)
### 🔍 Temas y simbolismo`
    },
    post: {
        rol: "Eres estratega de contenido para redes sociales.",
        estructura: `Estructura obligatoria:
### 🎯 Estrategia (red social, objetivo, público)
### ✨ Variante 1 — Emocional
### 💼 Variante 2 — Profesional
### 😄 Variante 3 — Divertida
(cada variante con gancho, cuerpo, llamado a la acción y hashtags)
### 🕒 Mejor horario para publicar y formato visual recomendado
### 📊 Cómo medir si funcionó`
    },
    poema: {
        rol: "Eres poeta y profesor de literatura.",
        estructura: `Estructura obligatoria:
### 🪶 Poema (con título)
### 🔎 Análisis (forma, métrica, rima y figuras retóricas usadas, con ejemplos del poema)
### 🎭 Cómo leerlo en voz alta`
    }
};

const extensiones = { corta: "Extensión breve.", media: "Extensión media.", larga: "Extensión larga y muy detallada." };

// Convierte las opciones de cada tipo en texto para el prompt
function describirOpciones(opciones = {}) {
    return Object.entries(opciones)
        .filter(([, v]) => textoValido(String(v ?? "")))
        .slice(0, 10)
        .map(([k, v]) => `${k.toUpperCase()}: ${String(v).slice(0, 200)}`)
        .join("\n");
}

function instruccionCreativa(tipo) {
    const t = tiposCreativos[tipo];
    return `${t.rol}
Responde siempre en español (salvo el código y los nombres técnicos).
Todo el contenido debe ser 100% original: no copies letras, poemas, guiones ni textos existentes, ni imites obras protegidas.
${t.estructura}`;
}

app.post("/api/crear", async (req, res) => {
    try {
        const { tipo = "historia", idea, tono = "", extension = "media", opciones = {} } = req.body;

        if (!textoValido(idea)) return res.status(400).json({ error: "Describe tu idea." });
        if (!Object.hasOwn(tiposCreativos, tipo)) return res.status(400).json({ error: "Ese tipo de contenido no existe." });

        const prompt = [
            `IDEA: ${idea.trim().slice(0, 3000)}`,
            describirOpciones(opciones),
            tono && `TONO: ${tono}`,
            extensiones[extension] || extensiones.media
        ].filter(Boolean).join("\n");

        console.log("=================================");
        console.log("CREANDO:", tipo);

        const { texto, modelo } = await llamarGemini({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: { systemInstruction: instruccionCreativa(tipo), temperature: tipo === "codigo" ? 0.4 : 0.95 }
        });

        if (!texto) return res.status(502).json({ error: "Gemini no devolvió contenido. Intenta de nuevo." });
        return res.json({ resultado: texto, modelo });
    } catch (error) {
        return manejarError(res, error);
    }
});

// Pide cambios sobre una creación anterior
app.post("/api/refinar", async (req, res) => {
    try {
        const { tipo = "historia", contenido, instruccion, idea = "" } = req.body;

        if (!textoValido(contenido)) return res.status(400).json({ error: "No hay contenido para mejorar." });
        if (!textoValido(instruccion)) return res.status(400).json({ error: "Escribe qué quieres cambiar." });
        if (!Object.hasOwn(tiposCreativos, tipo)) return res.status(400).json({ error: "Ese tipo de contenido no existe." });

        const prompt = `IDEA ORIGINAL: ${String(idea).slice(0, 1000)}

VERSIÓN ACTUAL:
${contenido.slice(0, 30000)}

CAMBIO QUE PIDE EL USUARIO: ${instruccion.trim().slice(0, 1000)}

Reescribe la versión completa aplicando el cambio. Mantén la misma estructura de secciones
y todo lo que el usuario no pidió cambiar. Al final agrega una sección "### 🔄 Cambios realizados" con 2 a 4 puntos.`;

        console.log("REFINANDO:", tipo, "→", instruccion.slice(0, 60));

        const { texto, modelo } = await llamarGemini({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: { systemInstruction: instruccionCreativa(tipo), temperature: tipo === "codigo" ? 0.3 : 0.8 }
        });

        if (!texto) return res.status(502).json({ error: "Gemini no devolvió contenido. Intenta de nuevo." });
        return res.json({ resultado: texto, modelo });
    } catch (error) {
        return manejarError(res, error);
    }
});

// Evaluación crítica de la creación (JSON con calificaciones)
const criteriosEvaluacion = {
    codigo: ["Funcionalidad", "Legibilidad", "Buenas prácticas", "Eficiencia", "Manejo de errores"],
    guion: ["Gancho", "Ritmo", "Claridad del mensaje", "Potencial viral", "Llamado a la acción"],
    cancion: ["Originalidad", "Gancho del coro", "Rima y métrica", "Emoción", "Coherencia musical"],
    historia: ["Originalidad", "Personajes", "Estructura", "Estilo", "Final"],
    post: ["Gancho", "Claridad", "Engagement", "Adecuación a la red", "Llamado a la acción"],
    poema: ["Originalidad", "Imágenes", "Ritmo", "Lenguaje", "Emoción"]
};

app.post("/api/evaluar-creacion", async (req, res) => {
    try {
        const { tipo = "historia", contenido } = req.body;
        if (!textoValido(contenido)) return res.status(400).json({ error: "No hay contenido para evaluar." });
        if (!Object.hasOwn(tiposCreativos, tipo)) return res.status(400).json({ error: "Ese tipo de contenido no existe." });

        const criterios = criteriosEvaluacion[tipo];
        const prompt = `Evalúa con honestidad, como un experto exigente, el siguiente contenido de tipo "${tipo}".

CONTENIDO:
${contenido.slice(0, 30000)}

Responde SOLO con un JSON válido:
{
  "calificaciones": [${criterios.map((c) => `{ "criterio": "${c}", "nota": 0, "comentario": "por qué" }`).join(", ")}],
  "fortalezas": ["fortaleza concreta"],
  "mejoras": [{ "problema": "qué se puede mejorar", "sugerencia": "cómo mejorarlo exactamente", "instruccion": "instrucción corta para pedir ese cambio, ej. 'Haz el coro más pegajoso'" }],
  "veredicto": "evaluación final en 2 oraciones"
}
Notas enteras del 1 al 10, sin inflarlas. Entre 3 y 5 mejoras.`;

        const { texto, modelo } = await llamarGemini({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: {
                systemInstruction: "Eres un crítico y editor experto. Respondes en español y das retroalimentación específica y útil.",
                responseMimeType: "application/json",
                temperature: 0.3
            }
        });

        let evaluacion;
        try {
            evaluacion = leerJSON(texto);
        } catch {
            return res.status(502).json({ error: "No se pudo leer la evaluación. Intenta de nuevo." });
        }
        return res.json({ evaluacion, modelo });
    } catch (error) {
        return manejarError(res, error);
    }
});

// =====================================
// 8. ERRORES Y RUTAS NO EXISTENTES
// =====================================

// JSON mal formado o archivo demasiado grande
app.use((err, req, res, next) => {
    if (err.type === "entity.too.large") {
        return res.status(413).json({ error: `El archivo es demasiado grande. Máximo ${MAX_PDF_MB} MB.` });
    }
    if (err.type === "entity.parse.failed") {
        return res.status(400).json({ error: "Los datos enviados no son válidos." });
    }
    next(err);
});

app.use((req, res) => {
    res.status(404).json({ error: "Ruta no encontrada." });
});

// =====================================
// 9. INICIAR SERVIDOR
// =====================================

app.listen(PORT, () => {
    console.log("=================================");
    console.log("HACKATON INICIADO CORRECTAMENTE");
    console.log(`Servidor: http://localhost:${PORT}`);
    console.log("=================================");
});