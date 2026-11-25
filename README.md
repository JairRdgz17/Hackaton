# ✦ Asistente IA con Google Gemini

**¿Qué quieres hacer hoy?** Una sola app con tres herramientas que usan la API de Google Gemini para **entender**, **decidir** y **crear**.

Proyecto desarrollado para el hackathon de Major League Hacking (MLH), usando la **Gemini API**.

---

## Los tres módulos

### 1. Entender un artículo de investigación (módulo principal)
Subes un paper en PDF (aunque esté en inglés) y Gemini lo lee completo para generar un **análisis profundo** en español:

| Sección | Qué incluye |
|---|---|
| ⚡ Resumen | Resumen ejecutivo, antecedentes, problema, brecha de conocimiento y justificación |
| 🎯 Objetivos | Objetivo general, objetivos específicos, preguntas de investigación e hipótesis |
| 🧪 Metodología | Enfoque, diseño, muestra, tabla de variables, instrumentos, procedimiento y análisis de datos |
| 📊 Resultados | Cada hallazgo con su evidencia numérica y la página o tabla donde aparece |
| 🏁 Conclusiones | Conclusiones, contribuciones, limitaciones, trabajo futuro y aplicaciones |
| ⚖️ Análisis crítico | Calificación de 1 a 10 en 5 criterios, fortalezas, debilidades, sesgos, validez interna y externa, reproducibilidad y nivel de evidencia |
| 🔑 Conceptos | Glosario de los términos clave |

Además ofrece **7 análisis avanzados** bajo demanda (estadístico, detector de sesgos, debate a favor y en contra, guía para replicar el estudio, ideas de investigación, guía de estudio y citas en APA/IEEE/MLA/Chicago), un **chat para hacerle preguntas al artículo** con la página de referencia y **exportación a PDF**.

### 2. Coach personal
- Perfil del usuario: objetivo, situación, tiempo disponible, obstáculo principal y estilo preferido.
- **Diagnóstico** con fortalezas, obstáculos y sus soluciones, y una **meta SMART**.
- **Plan de acción** de 6 a 10 pasos con plazo y dificultad, con **seguimiento del progreso**.
- Hábitos, métricas para medir el avance y técnicas recomendadas.
- Herramientas extra: rutina semanal, plan B contra obstáculos, reto de 30 días, errores a evitar y carta motivacional.
- Chat con un coach que conoce el plan y el progreso del usuario. Todo se guarda en el navegador.

### 3. Estudio creativo
- Genera código, guiones, canciones, historias, posts y poemas con opciones específicas para cada tipo.
- **Evaluación** por un "crítico experto" con calificaciones y sugerencias que se aplican con un clic.
- **Refinamiento** con cambios rápidos o personalizados y un **historial de versiones** (v1, v2, v3…).
- **Vista previa en vivo** del código web generado, descarga en el formato correcto e historial de creaciones.

---

## 🛠️ Tecnologías

- **Backend:** Node.js + Express
- **IA:** Google Gemini API con el SDK oficial [`@google/genai`](https://www.npmjs.com/package/@google/genai)
- **Frontend:** HTML, CSS y JavaScript puro (sin frameworks), responsivo para celular, tablet y computadora

## Cómo usamos la API de Gemini

- **Lectura nativa de PDF:** el PDF se envía directamente a Gemini (`inlineData` con `application/pdf`), sin extraer el texto antes.
- **Respuestas estructuradas en JSON** (`responseMimeType: "application/json"`) para mostrar el análisis, el diagnóstico y las evaluaciones en tarjetas, pestañas y gráficas.
- **Instrucciones de sistema** (`systemInstruction`) que convierten a Gemini en revisor científico, coach o crítico, según el módulo.
- **Conversaciones con memoria:** el historial se envía en cada mensaje.
- **Tolerancia a fallos:** si el modelo está saturado (errores 429 o 503), la app reintenta con espera creciente y, si sigue fallando, cambia a un modelo de respaldo.

---

## Cómo correrlo

**Requisitos:** Node.js 22 o más reciente y una API key de Gemini (se obtiene gratis en Google AI Studio).

```bash
# 1. Clona el repositorio
git clone <url-de-este-repositorio>
cd <carpeta-del-proyecto>

# 2. Instala las dependencias
npm install

# 3. Crea tu archivo .env a partir del ejemplo y pon tu API key
cp .env.example .env

# 4. Inicia el servidor
npm start
```

Abre **http://localhost:3000** en tu navegador.

### Variables de entorno

| Variable | Descripción | Valor por defecto |
|---|---|---|
| `GEMINI_API_KEY` | Tu API key de Gemini (obligatoria) | — |
| `PORT` | Puerto del servidor | `3000` |
| `GEMINI_MODEL` | Modelo principal | `gemini-3.8-flash` |
| `GEMINI_FALLBACK_MODEL` | Modelo de respaldo | `gemini-3.5-flash-lite` |
| `USE_VERTEXAI` | `true` si tu key es de Vertex AI | `false` |


---

## Estructura

```
├── server.js          # Servidor Express y conexión con Gemini
├── public/
│   └── index.html     # Interfaz completa (HTML, CSS y JS)
├── .env.example       # Ejemplo de variables de entorno
└── package.json
```

## Rutas de la API

| Ruta | Módulo | Qué hace |
|---|---|---|
| `GET /api/status` | — | Estado del servidor |
| `POST /api/diagnostico` | Coach | Diagnóstico y plan de acción (JSON) |
| `POST /api/consejo` | Coach | Chat con el coach |
| `POST /api/consejo-extra` | Coach | Herramientas extra |
| `POST /api/resumir` | Artículos | Análisis profundo del artículo (JSON) |
| `POST /api/analisis-extra` | Artículos | Análisis especializados |
| `POST /api/preguntar` | Artículos | Preguntas sobre el artículo |
| `POST /api/crear` | Crear | Genera contenido |
| `POST /api/refinar` | Crear | Aplica cambios a una versión |
| `POST /api/evaluar-creacion` | Crear | Evaluación con calificaciones (JSON) |

---

## Aviso

Los análisis, consejos y evaluaciones los genera inteligencia artificial y pueden contener errores. El coach no sustituye la atención de profesionales de la salud, psicología o finanzas.