/**
 * Universal Node Types
 *
 * This module defines the type system for universal nodes - config-driven nodes
 * that execute 1-N steps sequentially without requiring code deployment.
 *
 * Universal nodes support step types:
 * - neuron: Execute LLM calls
 * - tool: Call MCP tools
 * - transform: Transform data (map/filter/select)
 * - conditional: Set fields based on conditions
 * - loop: Iterate over steps
 * - delay: Wait for specified time
 * - connection: Access user's external service credentials
 */

/**
 * Step types available in universal nodes
 */
export type StepType = 'neuron' | 'tool' | 'transform' | 'conditional' | 'loop' | 'delay' | 'connection' | 'graph';

/**
 * Error Handling Configuration
 *
 * Controls retry logic, fallback strategies, and error propagation behavior
 * for individual steps in universal nodes.
 */
export interface ErrorHandlingConfig {
    /** Number of retry attempts after initial failure. Default: 0 (no retries) */
    retry?: number;
    /** Delay in milliseconds between retry attempts. Default: 1000ms */
    retryDelay?: number;
    /** Value to use if step fails after all retries. Only used with onError='fallback' */
    fallbackValue?: any;
    /**
     * Error handling strategy:
     * - 'throw': Throw error and stop execution (default)
     * - 'fallback': Use fallbackValue and continue
     * - 'skip': Skip this step and continue (outputField will be undefined)
     */
    onError?: 'throw' | 'fallback' | 'skip';
}

/**
 * Neuron Step - Execute an LLM call
 *
 * Use cases:
 * - Generate text (summaries, answers, explanations)
 * - Classify or analyze content
 * - Extract structured data from text
 * - Refine or optimize queries
 *
 * Template variables:
 * - Use {{state.fieldName}} to inject state values
 * - Supports nested paths: {{state.user.name}}
 */
export interface NeuronStepConfig {
    /** Which neuron (model) to use. If not specified, uses defaultNeuronId from state */
    neuronId?: string;
    /** System message to guide LLM behavior (optional) */
    systemPrompt?: string;
    /** User prompt - REQUIRED. Supports template variables like {{state.field}} */
    userPrompt: string;
    /** Temperature for LLM (0.0 = deterministic, 1.0 = creative). Default: 0.7 */
    temperature?: number;
    /** Maximum tokens in LLM response. Default: 2000 */
    maxTokens?: number;
    /** Field name to store LLM response in state. REQUIRED */
    outputField: string;
    /**
     * Whether to stream this neuron's output to the user in real-time.
     *
     * - `true`: Stream chunks to user (like ChatGPT typing effect)
     * - `false` or `undefined`: Run silently, only final result visible (internal step)
     *
     * Use Cases:
     * - Final response generation: `stream: true` (user sees progress)
     * - Internal evaluation/classification: `stream: false` (silent processing)
     * - Analysis shown to user: `stream: true` (engaging UX)
     *
     * Note: All neurons use streaming internally for 10-20% performance improvement,
     * this flag only controls whether chunks are sent to the user.
     *
     * @default false
     */
    stream?: boolean;
    /**
     * JSON Schema for structured output.
     *
     * When provided, uses LangChain's `.withStructuredOutput()` to force the model
     * to return a valid JSON object matching the schema. This is more reliable than
     * parsing JSON from freeform text responses.
     *
     * Supported by: OpenAI, Anthropic, Google, and most modern models.
     *
     * Use Cases:
     * - Planning/routing decisions (force valid plan structure)
     * - Classification (force specific categories)
     * - Data extraction (force specific fields)
     *
     * Example:
     * ```json
     * {
     *   "type": "object",
     *   "properties": {
     *     "decision": {"type": "string", "enum": ["search", "respond"]},
     *     "confidence": {"type": "number", "minimum": 0, "maximum": 1}
     *   },
     *   "required": ["decision", "confidence"]
     * }
     * ```
     *
     * @default undefined (freeform text response)
     */
    structuredOutput?: {
        /** JSON Schema object defining the expected structure */
        schema: Record<string, any>;
        /**
         * Method to use for structured output (optional).
         * Default: 'auto' (uses best method for the model)
         * Options: 'auto', 'function_calling', 'json_mode', 'jsonSchema'
         */
        method?: 'auto' | 'function_calling' | 'json_mode' | 'jsonSchema';
        /** Optional name for the structured output function (default: 'extract') */
        name?: string;
    };
    /** Error handling configuration for this neuron step */
    errorHandling?: ErrorHandlingConfig;
}

/**
 * Tool Step - Call an MCP tool
 *
 * Use cases:
 * - Search the web or vector database
 * - Scrape URLs for content
 * - Execute system commands
 * - Fetch data from external APIs
 *
 * Available tools:
 * - web_search: Google search via MCP web server
 * - scrape_url: Fetch and parse URL content
 * - run_command: Execute shell command (sandboxed)
 * - search_documents: RAG vector search
 * - get_conversation: Load conversation history
 */
export interface ToolStepConfig {
    /** Name of the MCP tool to call (e.g., 'web_search', 'scrape_url') */
    toolName: string;
    /** Parameters to pass to the tool. Supports template variables in values */
    parameters: Record<string, any>;
    /** Field name to store tool result in state. REQUIRED */
    outputField: string;
    /**
     * Connection ID for authenticated tool calls.
     * When set, the tool executor resolves credentials from the user's
     * connected accounts and passes them to the tool via meta/context.
     * Supports template variables: "{{state.connectionId}}"
     */
    connectionId?: string;
    /**
     * Provider ID for authenticated tool calls (e.g., 'google', 'github', 'stripe').
     * Uses the user's default connection for this provider.
     * Only used if connectionId is not set.
     */
    providerId?: string;
    /** @deprecated Use errorHandling.retry instead */
    retryOnError?: boolean;
    /** @deprecated Use errorHandling.retry instead */
    maxRetries?: number;
    /** Error handling configuration for this tool step */
    errorHandling?: ErrorHandlingConfig;
}

/**
 * Transform Step - Data manipulation operations
 *
 * Supported operations:
 * - map: Extract field from array items (e.g., item.url → array of URLs)
 * - filter: Filter array items by condition (e.g., item.score > 0.8)
 * - select: Extract nested property from object (e.g., response.user.name)
 * - parse-json: Parse JSON string into object/array
 * - append: Append value to array (creates array if doesn't exist)
 * - concat: Concatenate two arrays
 * - build-messages: Build LLM message array with role/content pairs
 * - increment: Add to a number value (defaults to +1)
 * - decrement: Subtract from a number value (defaults to -1)
 */
export interface TransformStepConfig {
    /** Type of transformation to perform */
    operation: 'map' | 'filter' | 'select' | 'json' | 'parse-json' | 'append' | 'concat' | 'build-messages' | 'set' | 'set-global' | 'get-global' | 'increment' | 'decrement';
    /** Source field in state to transform (optional for build-messages) */
    inputField?: string;
    /** Destination field in state to store result. REQUIRED */
    outputField: string;
    /**
     * For map/select: Path expression to extract (e.g., 'item.url' for map, 'user.name' for select)
     * item.property for map operations (applied to each array item)
     * property.nested for select operations (applied to single object)
     */
    transform?: string;
    /**
     * For filter: Condition expression (e.g., 'item.score > 0.5')
     * Supports: >, <, >=, <=, ===, !==
     */
    filterCondition?: string;
    /**
     * For append: Value to append to the array (supports template variables)
     * For concat: Second array field to concatenate with inputField
     */
    value?: any;
    /**
     * For append: Optional condition to check before appending.
     * If provided and evaluates to false, the value will not be appended.
     * Supports template variables and boolean expressions.
     * Example: '{{state.needsRespond}} == false' (only append if false)
     */
    condition?: string;
    /**
     * For build-messages: Array of message templates with role and content
     * Example: [{ role: 'system', content: '{{state.systemMessage}}' }, { role: 'user', content: '{{state.query}}' }]
     */
    messages?: Array<{
        role: string;
        content: string;
    }>;
    /**
     * For build-messages: State field containing pre-built messages array
     * If present, return this field directly instead of building from scratch
     */
    useExistingField?: string;
    /**
     * For set-global/get-global: Global state namespace
     * Example: 'user-settings', 'workflow-state'
     */
    namespace?: string;
    /**
     * For set-global/get-global: Key within the namespace
     * Example: 'api_key', 'counter'
     */
    key?: string;
    /**
     * For set-global: TTL in seconds (optional)
     * If provided, the value will auto-expire after this time
     */
    ttlSeconds?: number;
    /**
     * For set-global: Description of the value (optional)
     */
    description?: string;
}

/**
 * Conditional Step - Set field based on condition evaluation
 *
 * Use cases:
 * - Set flags based on state conditions
 * - Control subsequent node routing
 * - Make binary decisions
 *
 * Condition expressions support:
 * - Comparisons: ===, !==, >, <, >=, <=
 * - Logical: &&, ||
 * - String methods: .includes(), .startsWith(), .toLowerCase()
 * - Nested paths: state.user.accountLevel >= 3
 */
export interface ConditionalStepConfig {
    /** Boolean expression to evaluate (e.g., 'state.confidence > 0.8') */
    condition: string;
    /** Field name to set in state based on condition result. REQUIRED */
    setField: string;
    /** Value to set if condition is true */
    trueValue: any;
    /** Value to set if condition is false */
    falseValue: any;
}

/**
 * Loop Step - Execute steps repeatedly until exit condition is met
 *
 * Use cases:
 * - Iterative web search (search → evaluate → refine query → repeat)
 * - Retry logic with refinement
 * - Batch processing with accumulation
 * - Progressive improvement of results
 *
 * Exit condition support:
 * - State field comparison: state.confidence > 0.8
 * - Iteration count: state.loopIteration >= 3
 * - Boolean flags: state.searchComplete === true
 * - Complex expressions: state.resultsCount > 5 && state.relevance > 0.7
 */
export interface LoopStepConfig {
    /** Maximum iterations before forcing exit (safety limit). REQUIRED */
    maxIterations: number;
    /**
     * Exit condition expression evaluated after each iteration.
     * Loop exits when this evaluates to true.
     *
     * Examples:
     * - "state.searchComplete === true"
     * - "state.confidence > 0.8"
     * - "state.resultsFound > 10"
     * - "state.loopIteration >= 3"
     *
     * Available variables:
     * - state.* - All fields set by loop steps and previous nodes
     * - state.loopIteration - Current iteration number (1-indexed)
     * - state.loopAccumulator - Accumulated results array
     */
    exitCondition: string;
    /**
     * Field to accumulate results from each iteration.
     * If specified, after each iteration the value of state[accumulatorField]
     * is appended to an array stored in state[accumulatorField + 'Array']
     *
     * Example: accumulatorField='searchResults' creates 'searchResultsArray'
     *
     * Optional - omit if you only need the final iteration's state
     */
    accumulatorField?: string;
    /**
     * Steps to execute in each iteration.
     * These steps run sequentially and can read/write state fields
     */
    steps: UniversalStep[];
    /**
     * Behavior when maxIterations is reached without meeting exit condition
     * - 'continue': Proceed with current state (default, safe)
     * - 'throw': Throw error (use for critical failures)
     */
    onMaxIterations?: 'continue' | 'throw';
}

/**
 * Connection Step - Access user's external service credentials
 *
 * Use cases:
 * - Get OAuth tokens for API calls (Google, GitHub, Slack, etc.)
 * - Get API keys for external services (OpenAI, SendGrid, etc.)
 * - Make authenticated HTTP requests to third-party services
 *
 * The connection step fetches credentials from the user's connected accounts
 * and makes them available in the state for subsequent tool/transform steps.
 *
 * Security: Credentials are decrypted at runtime but never logged or exposed.
 */
export interface ConnectionStepConfig {
    /**
     * Connection ID to use. If not provided, uses the default connection for the provider.
     * Supports template variables: "{{state.connectionId}}"
     */
    connectionId?: string;
    /**
     * Provider ID to use for default connection lookup.
     * Required if connectionId is not provided.
     * Examples: 'google', 'github', 'openai', 'twilio'
     */
    providerId?: string;
    /**
     * Field name to store the connection context in state.
     * The context includes: headers (for authenticated requests),
     * accountInfo (email, name), and raw credentials (for custom use).
     * REQUIRED
     */
    outputField: string;
    /**
     * What to include in the output:
     * - 'headers': Only auth headers (safest, recommended for most cases)
     * - 'full': Headers + accountInfo + raw credentials
     * - 'account': Headers + accountInfo (useful for display)
     *
     * Default: 'headers'
     */
    include?: 'headers' | 'full' | 'account';
    /**
     * Error handling configuration for this connection step
     */
    errorHandling?: ErrorHandlingConfig;
}

/**
 * Graph Step — invoke another graph as a subgraph
 *
 * Use cases:
 * - Compose complex workflows from smaller, reusable graphs
 * - Run a specialist graph (e.g. "research") from within a coordinator graph
 * - Fan out to multiple specialist graphs and merge results
 *
 * Execution semantics:
 * - Shares the parent's RunPublisher, mcpClient, neuronRegistry, and connectionManager
 * - Does NOT acquire a separate RunLock — runs within the parent's lock
 * - Does NOT create its own Redis run state — events flow through parent's publisher
 * - Recursion guard: max depth 5 (configurable via MAX_SUBGRAPH_DEPTH in graphExecutor)
 */
export interface GraphStepConfig {
    /** ID of the graph to invoke — must exist in the MongoDB 'graphs' collection */
    graphId: string;
    /**
     * Maps subgraph input fields to parent state paths.
     * Source paths support {{state.X}} template syntax.
     * If omitted, the parent's entire data object is passed through.
     *
     * Example: { "topic": "{{state.data.userTopic}}", "depth": "{{state.data.searchDepth}}" }
     */
    inputMapping?: Record<string, string>;
    /**
     * State field where the subgraph's output will be stored in the parent state.
     * Supports dot-notation for nested writes: "data.subResult"
     */
    outputField: string;
    /** Maximum execution time in milliseconds. No timeout if omitted. */
    timeout?: number;
    /** Error handling configuration for this graph step */
    errorHandling?: {
        retry?: number;
        retryDelay?: number;
        fallbackValue?: any;
        onError?: 'throw' | 'fallback' | 'skip';
    };
}

/**
 * Universal Step - One of the step types
 *
 * Each step executes sequentially and can read state from previous steps.
 * Steps accumulate state changes that are merged at the end of node execution.
 */
export interface UniversalStep {
    /** Type of step to execute */
    type: StepType;
    /** Configuration for the step (type depends on step type) */
    config: NeuronStepConfig | ToolStepConfig | TransformStepConfig | ConditionalStepConfig | LoopStepConfig | ConnectionStepConfig | GraphStepConfig;
    /**
     * Optional condition to determine if this step should run.
     * If provided, the step only runs if the condition evaluates to true.
     * Supports template syntax: "{{state.someField}} == 'someValue'"
     */
    condition?: string;
}

/**
 * Parameter Definition for Node
 * Defines an exposed parameter that can be customized at the graph level
 */
export interface ParameterDefinition {
    /** Parameter value type */
    type: 'string' | 'number' | 'boolean' | 'select' | 'json';
    /** Default value (used when graph doesn't override) */
    default: any;
    /** Human-readable description */
    description?: string;
    /** For number type: minimum value */
    min?: number | null;
    /** For number type: maximum value */
    max?: number | null;
    /** For select type: allowed values */
    enum?: any[] | null;
    /** Whether this parameter is required (no default fallback) */
    required?: boolean;
    /** Which step index this parameter applies to (for UI hints) */
    stepIndex?: number | null;
    /** The path within step config where this parameter is used */
    configPath?: string | null;
}

/**
 * Map of parameter name to definition
 */
export type NodeParameters = Record<string, ParameterDefinition>;

/**
 * Resolved parameter values (merged defaults + overrides)
 */
export type ResolvedParameters = Record<string, any>;

/**
 * Universal Node Configuration
 *
 * Supports two formats:
 *
 * 1. Single-step (shorthand):
 *    { type: 'neuron', config: { ... } }
 *
 * 2. Multi-step (array):
 *    { steps: [{ type: 'neuron', config: {...} }, { type: 'tool', config: {...} }] }
 *
 * Multi-step nodes execute steps sequentially, with each step able to access
 * state fields set by previous steps.
 *
 * Parameters System:
 * - Node defines `parameters` schema (exposed customizable values)
 * - Graph can override via `config.parameters: { temperature: 0.3 }`
 * - At runtime, parameters are merged and available as {{parameters.xxx}}
 */
export interface NodeConfig {
    /**
     * Node identifier (e.g., "router", "search", "respond")
     */
    nodeId?: string;
    /**
     * Human-readable node name (e.g., "Intelligent Router", "Web Search")
     */
    name?: string;
    /**
     * Multi-step format: Array of steps to execute sequentially
     * Each step can read state from previous steps
     */
    steps?: UniversalStep[];
    /**
     * Single-step format (shorthand): Step type
     * Use this for simple single-operation nodes
     */
    type?: StepType;
    /**
     * Single-step format (shorthand): Step configuration
     * Use this for simple single-operation nodes
     */
    config?: NeuronStepConfig | ToolStepConfig | TransformStepConfig | ConditionalStepConfig | LoopStepConfig;
    /**
     * Exposed parameters schema
     * Defines what values can be customized at the graph level
     *
     * Example:
     * {
     *   temperature: { type: 'number', default: 0.7, min: 0, max: 2 },
     *   model: { type: 'select', default: 'gpt-4', enum: ['gpt-4', 'gpt-3.5'] }
     * }
     */
    parameters?: NodeParameters;
    /**
     * Resolved parameter values (set at runtime after merging defaults + graph overrides)
     * Available in templates as {{parameters.xxx}}
     */
    resolvedParameters?: ResolvedParameters;
}
