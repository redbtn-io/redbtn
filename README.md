# redbtn AI

 A connector and interface designed to simplify interaction with various AI platforms. Currently, it serves as a connector for OpenAI, offering a streamlined way to interact with OpenAI's APIs through a unified interface. This project is part of the redbtn automation platform.

## Features

- **Assistants**: Create, retrieve, update, and delete AI assistants.
- **Threads**: Manage conversation threads, including creation, retrieval, editing, and deletion.
- **Messages**: Handle messages within threads, including creation, retrieval, updating, and deletion.
- **Runs**: Run threads with specific parameters and manage the results.
- **Files**: Upload, retrieve, read, and delete files used by AI assistants.
- **Vectors**: Create, retrieve, update, and delete vector stores for managing embeddings.
- **Vector Files**: Manage files associated with vector stores.
- **Vector Batches**: Create and manage batches of files within vector stores.

## Installation

To use redbtn AI, ensure you have Node.js and npm installed. Install the package using npm:

```bash
npm install @redbtn/ai
```

## Configuration

Ensure you have your OpenAI API key available. Set it up in your environment variables:

```bash
export OPENAI_API_KEY=your_openai_api_key
```

## Usage

Import the AI module in your application and interact with an Assistant:

```typescript
import { AI } from './index';

// Creating an assistant
const createAssistant = async () => {
  try {
    const response = await AI.createAssistant({ model: 'gpt-3.5-4o-mini' });
    console.log(response);
  } catch (error) {
    console.error('Error creating assistant:', error);
  }
};

// Editing an assistant
const editAssistant = async (id: string) => {
  try {
    const response = await Assistant.editAssistant(id, { model: 'gpt-3.5-turbo-1106', name: 'Updated Assistant' });
    console.log('Assistant updated:', response);
  } catch (error) {
    console.error('Error editing assistant:', error);
  }
};

// Retrieving an assistant
const getAssistant = async (id: string) => {
  try {
    const response = await Assistant.getAssistant(id);
    console.log('Assistant details:', response);
  } catch (error) {
    console.error('Error retrieving assistant:', error);
  }
};

// Deleting an assistant
const deleteAssistant = async (id: string) => {
  try {
    const response = await Assistant.deleteAssistant(id);
    console.log('Assistant deleted:', response);
  } catch (error) {
    console.error('Error deleting assistant:', error);
  }
};

// Usage
createAssistant();
editAssistant('assistant-id');
getAssistant('assistant-id');
deleteAssistant('assistant-id');

createAssistant();
```
#### Realtime Example

```typescript
import { RealtimeAI } from '@redbtn/ai';

// Initialize RealtimeAI with onMessage and onOpen handlers
const ai = new RealtimeAI({
  onMessage: (message: string) => {
    console.log("Received message:", message);
  },
  onOpen: () => {
    console.log("WebSocket connection opened.");
  }
});

// Send a message to the AI
ai.send("Hello, AI!");

// Request the AI to create a response
ai.createResponse();

// Update the session with new parameters
ai.updateSession({
  instructions: "Your name is Red. You are speaking with George. Respond naturally as you would in a podcast conversation, but don't be too overly-excited.",
  modalities: ["text"],
  voice: "shimmer"
});

// Event listener for events
ai.on("response", (message: string) => {
  console.log(`Red - ${message}`);
});

ai.on("delta", (letter: string) => {
  stdout.write(data);
});

ai.on("open", () => {
  console.log('open');
});

ai.on("error", () => {
  console.log('error');
});

ai.on("close", () => {
  console.log('close');
});

```
## Reference

### Realtime AI

- `RealtimeAI`: Class to interact with AI in real-time using WebSockets.
  - `constructor({ onMessage, onOpen })`: Initializes the WebSocket connection with optional `onMessage` and `onOpen` handlers.
  - `send(message: string)`: Sends a message to the AI.
  - `createResponse()`: Requests the AI to create a response.
  - `updateSession(session: any)`: Updates the session with new parameters.
  - `set onMessage(fn: Function)`: Sets the handler for incoming messages.
  - `set onOpen(fn: Function)`: Sets the handler for the WebSocket open event.
  - `on(eventName: string, listener: Function)`: Adds an event listener.
  - `emit(eventName: string, ...args: any[])`: Emits an event to all registered listeners.

### Assistants

- `createAssistant(params?: AssistantCreateParams)`: Creates a new assistant.
- `editAssistant(id: string, params: AssistantCreateParams)`: Updates an existing assistant.
- `getAssistant(id: string)`: Retrieves details of an assistant.
- `deleteAssistant(id: string)`: Deletes an assistant.

### Threads

- `createThread(params?: ThreadCreation)`: Creates a new thread.
- `getThread(id: string)`: Retrieves details of a thread.
- `editThread(id: string, params: any)`: Updates a thread.
- `deleteThread(id: string)`: Deletes a thread.

### Messages

- `createMessage(threadId: string, message: string, params?: any)`: Creates a new message in a thread.
- `getMessage(threadId: string, messageId: string)`: Retrieves a message from a thread.
- `editMessage(threadId: string, messageId: string, params: any)`: Updates a message.
- `deleteMessage(threadId: string, messageId: string)`: Deletes a message.
- `listMessages(threadId: string)`: Lists all messages in a thread.

### Runs

- `runThread(assistant_id: string, thread: string, params?: any)`: Runs a thread with an assistant.
- `submitTools(threadId: string, runId: string, outputs: any[])`: Submits tool outputs for a run.
- `getRun(threadId: string, runId: string)`: Retrieves details of a run.
- `editRun(threadId: string, runId: string, params: any)`: Updates a run.
- `cancelRun(threadId: string, runId: string)`: Cancels a run.
- `listRuns(threadId: string)`: Lists all runs in a thread.

### Files

- `uploadFile(file: File)`: Uploads a file for use with assistants.
- `getFile(id: string)`: Retrieves a file by ID.
- `readFile(id: string)`: Reads the content of a file.
- `deleteFile(id: string)`: Deletes a file.
- `listFiles()`: Lists all files.

### Vectors

- `createVector(params: VectorStoreCreateParams)`: Creates a new vector store.
- `getVector(id: string)`: Retrieves a vector store by ID.
- `editVector(id: string, params: VectorStoreUpdateParams)`: Updates a vector store.
- `deleteVector(id: string)`: Deletes a vector store.
- `listVectors()`: Lists all vector stores.

### Vector Files

- `addVectorFile(vector_id: string, file: string)`: Adds a file to a vector store.
- `listVectorFiles(id: string)`: Lists all files in a vector store.
- `getVectorFile(id: string, fileId: string)`: Retrieves a file from a vector store.
- `deleteVectorFile(id: string, fileId: string)`: Deletes a file from a vector store.

### Vector Batches

- `createBatch(id: string, file_ids: string[])`: Creates a batch of files for a vector store.
- `getBatch(id: string, batchId: string)`: Retrieves a batch by ID.
- `listBatches(id: string, batchId: string)`: Lists files in a batch.
- `deleteBatch(id: string, batchId: string)`: Deletes a batch.

## Contributing

Feel free to submit issues or pull requests. For detailed information on contributing, please refer to the [CONTRIBUTING.md](CONTRIBUTING.md) file.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## Contact

For questions or feedback, please contact us at [support@redbtn.io](mailto:support@redbtn.io).

---

Enjoy using redbtn AI for your automation needs!

