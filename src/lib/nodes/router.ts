
import { InvokeOptions } from '../../';

/**
 * Defines the state that flows through the redGraph.
 * It includes the original query and the invocation options.
 */
interface RedGraphState {
  query: object;
  options: InvokeOptions;
  response?: string;
  // This field will be populated by the router to direct the next step.
  nextGraph?: 'homeGraph' | 'assistantGraph' | 'chat'; 
}

/**
 * The first node in redGraph, acting as a router.
 * It directs the flow to a specialized graph or continues within redGraph
 * based on the application source provided in the options.
 * * @param state The current state of the graph.
 * @returns A partial state object indicating the next step.
 */
export async function routerNode(state: RedGraphState): Promise<Partial<RedGraphState>> {
  // Get the application name from the source options.
  const application = state.options?.source?.application;

  console.log(`[Router Node] Routing based on application: ${application || 'default'}`);

  switch (application) {
    case 'redHome':
      // Signal that the next step should be the homeGraph.
      return { nextGraph: 'homeGraph' };
    
    case 'redAssistant':
      // Signal that the next step should be the assistantGraph.
      return { nextGraph: 'assistantGraph' };

    case 'redChat':
    default:
      // For redChat or if no application is specified,
      // signal to continue to the next node in this graph.
      return { nextGraph: 'chat' };
  }
}