
import dotenv from 'dotenv';
import express from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config({
  path: resolve(__dirname, '.env'),
});

if (!process.env.GEMINI_API_KEY) {
  console.error('ERROR: GEMINI_API_KEY is missing from backend/.env');
  process.exit(1);
}

const app = express();
const PORT = 3001;

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const MODEL = 'gemini-3.5-flash-lite';

app.use(express.json({ limit: '10kb' }));

// Actions Gemini is allowed to request.
const functionDeclarations = [
  {
    name: 'select_object',
    description:
      'Select and show a complete object from the existing SnapSplode catalog. Do not explode or expand it automatically.',
    parameters: {
      type: 'OBJECT',
      properties: {
        object_id: {
          type: 'STRING',
          description: 'The exact ID of an object in the supplied catalog.',
        },
      },
      required: ['object_id'],
    },
  },
  {
    name: 'next_object',
    description: 'Select the next object in the catalog.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'previous_object',
    description: 'Select the previous object in the catalog.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'explode_object',
    description:
      'Expand or explode the currently selected object into its separate components. Only use when the user explicitly requests expansion, explosion, or pulling the object apart.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'assemble_object',
    description:
      'Bring the currently expanded object components together and assemble the complete object.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'disappear_object',
    description: 'Make the currently displayed object disappear.',
    parameters: { type: 'OBJECT', properties: {} },
  },
];

const allowedActions = new Set(
  functionDeclarations.map((item) => item.name),
);

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    server: 'SnapSplode backend',
    geminiKeyConfigured: true,
  });
});

// Existing Gemini connection test
app.post('/api/gemini-test', async (req, res) => {
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents:
        'Reply with exactly: Hello! SnapSplode Gemini connection is working.',
    });

    if (!response.text) {
      throw new Error('Gemini returned an empty response.');
    }

    res.json({
      success: true,
      reply: response.text,
    });
  } catch (error) {
    console.error('Gemini request failed:', error.message);

    res.status(500).json({
      success: false,
      error: 'Gemini request failed. Check the backend terminal.',
    });
  }
});

// Gemini agent endpoint
app.post('/api/agent', async (req, res) => {
  try {
    const {
      message,
      objects,
      sceneState,
      parts,
    } = req.body ?? {};

    // Validate the user's message.
    if (
      typeof message !== 'string' ||
      !message.trim() ||
      message.length > 1000
    ) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a message between 1 and 1000 characters.',
      });
    }

    // Validate the catalog.
    if (
      !Array.isArray(objects) ||
      objects.length === 0 ||
      objects.length > 50
    ) {
      return res.status(400).json({
        success: false,
        error: 'A valid SnapSplode object catalog is required.',
      });
    }

    // Accept only simple catalog information from the frontend.
    const catalog = objects
      .filter(
        (item) =>
          item &&
          typeof item.id === 'string' &&
          typeof item.name === 'string' &&
          typeof item.category === 'string',
      )
      .map(({ id, name, category }) => ({
        id: id.slice(0, 100),
        name: name.slice(0, 150),
        category: category.slice(0, 100),
      }));

    if (catalog.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'The supplied object catalog is invalid.',
      });
    }

    // Accept actual component information from the loaded 3D model.
    // These values come from the frontend's compiled model parts.
    const currentParts = Array.isArray(parts)
      ? parts
          .filter(
            (part) =>
              part &&
              typeof part.name === 'string',
          )
          .slice(0, 50)
          .map((part) => ({
            name: part.name.slice(0, 150),
            description:
              typeof part.description === 'string'
                ? part.description.slice(0, 500)
                : '',
            color:
              typeof part.color === 'string'
                ? part.color.slice(0, 50)
                : '',
          }))
      : [];

    const catalogText = catalog
      .map(
        (item) =>
          `ID: ${item.id} | Name: ${item.name} | Category: ${item.category}`,
      )
      .join('\n');

    // Keep scene information small and readable.
    let sceneText = '{}';

    try {
      sceneText = JSON.stringify(sceneState ?? {});
      sceneText = sceneText.slice(0, 3000);
    } catch {
      sceneText = '{}';
    }

    const partsText =
      currentParts.length > 0
        ? currentParts
            .map(
              (part, index) =>
                `${index + 1}. ${part.name}: ${
                  part.description || 'No description supplied.'
                }`,
            )
            .join('\n')
        : 'No component information is currently available.';

    const prompt = `
USER MESSAGE:
${message.trim()}

AVAILABLE SNAPSPLODE OBJECTS:
${catalogText}

CURRENT SCENE STATE:
${sceneText}

ACTUAL COMPONENTS OF THE CURRENTLY LOADED MODEL:
${partsText}

IMPORTANT INSTRUCTIONS:

1. OBJECT SELECTION
- When the user asks to show, display, or see an object, use select_object.
- Select only an exact object ID from the supplied catalog.
- Show the complete assembled object first.
- Never automatically expand an object after selecting it.
- Never invent an object or an object ID.
- If the requested object is not in the catalog, explain that it is unavailable.

2. EXPANDING OBJECTS
- Use explode_object only when the user explicitly asks to expand, explode, separate, or pull apart the current object.
- Do not expand when the user simply asks to show an object.
- Do not expand just because the user asks a question about a component.

3. COMPONENT QUESTIONS
- Use the actual component list supplied above.
- If the user asks what a component does, explain its purpose in simple words.
- If the user asks about a component of the current object, answer using the supplied component information.
- Do not invent components that are not in the supplied list.
- If the component list is unavailable, clearly say that you do not have the actual component information.

4. MANUFACTURING QUESTIONS
- If the user asks how a component is made, explain common manufacturing methods using general engineering knowledge.
- Make it clear that this is a general explanation, not verified manufacturing information about the exact model.
- Do not invent a manufacturer, factory, material specification, or exact manufacturing process.

5. ASSEMBLING
- Use assemble_object when the user asks to assemble, join, or bring the components back together.

6. OTHER SCENE COMMANDS
- Use next_object when the user asks for the next object.
- Use previous_object when the user asks for the previous object.
- Use disappear_object when the user asks to remove or make the current object disappear.

7. NORMAL CONVERSATION
- For ordinary questions and explanations, reply with helpful text.
- Do not call a scene function unless the user requests a scene action.
- Do not claim that an action has already happened. The browser will execute the requested action.
- Keep explanations clear, friendly, and suitable for a beginner.
`;

    const systemInstruction = `
You are the Gemini AI assistant inside SnapSplode, an interactive 3D learning application.

Your job is to help users explore real objects, understand their components, and control the existing 3D scene.

STRICT RULES:

- Only use objects from the supplied SnapSplode catalog.
- Never invent objects, catalog IDs, or model components.
- When asked to show an object, display it fully assembled.
- Never automatically explode an object after selecting it.
- Expand only after an explicit user request.
- Use the actual supplied component information for model-specific answers.
- Explain technical ideas in simple language.
- Clearly distinguish general engineering knowledge from verified information about the specific model.
- Use scene functions only when the user requests an action.
- Never say an action succeeded before the browser executes it.
- Be helpful, accurate, and concise.
`;

    const response = await ai.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: {
        systemInstruction,
        tools: [
          {
            functionDeclarations,
          },
        ],
      },
    });

    const responseParts =
      response.candidates?.[0]?.content?.parts ?? [];

    const functionCalls = responseParts
      .filter((part) => part.functionCall)
      .map((part) => part.functionCall);

    const actions = [];

    for (const call of functionCalls) {
      if (!allowedActions.has(call.name)) {
        continue;
      }

      const args = call.args ?? {};

      if (call.name === 'select_object') {
        const objectId = args.object_id;

        const exists = catalog.some(
          (item) => item.id === objectId,
        );

        if (!exists) {
          continue;
        }

        actions.push({
          name: call.name,
          args: {
            object_id: objectId,
          },
        });
      } else {
        actions.push({
          name: call.name,
          args: {},
        });
      }
    }

    res.json({
      success: true,
      reply:
        response.text ||
        (actions.length
          ? 'I understood your command.'
          : 'I could not determine that action. Please try again.'),
      actions,
    });
  } catch (error) {
    console.error('Gemini agent request failed:', error.message);

    res.status(500).json({
      success: false,
      error: 'The Gemini agent request failed. Check the backend terminal.',
    });
  }
});

// Start local backend
app.listen(PORT, () => {
  console.log('-------------------------------------');
  console.log('SnapSplode backend started');
  console.log(`Local address: http://localhost:${PORT}`);
  console.log(`Gemini model: ${MODEL}`);
  console.log('Gemini API key: Configured');
  console.log('Gemini agent endpoint: /api/agent');
  console.log('-------------------------------------');
});
