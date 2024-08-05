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

To use redbtn AI, ensure you have Node.js and npm (or yarn) installed. Clone the repository and install dependencies:

```bash
git clone https://github.com/your-username/redbtn-ai.git
cd redbtn-ai
npm install
# or
yarn install
```

## Configuration

Ensure you have your OpenAI API key available. Set it up in your environment variables:

```bash
export OPENAI_API_KEY=your_openai_api_key
```

## Usage

Import the AI module in your application:

```typescript
import { AI } from './index';

// Example: Creating an assistant
const createAssistant = async () => {
  try {
    const response = await AI.createAssistant({ model: 'gpt-3.5-turbo-1106' });
    console.log(response);
  } catch (error) {
    console.error('Error creating assistant:', error);
  }
};

createAssistant();
```

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