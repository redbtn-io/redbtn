
import { InvokeOptions } from '../..';

/**
 * The first node in redGraph, acting as a router.
 * It directs the flow to a specialized graph or continues within redGraph
 * based on the application source provided in the options.
 * @param state The current state of the graph.
 * @returns A partial state object indicating the next step.
 */
export async function routerNode(state: any): Promise<Partial<any>> {
  const application = state.options?.source?.application;

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