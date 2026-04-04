export declare const routerNode: (state: any) => Promise<{
    nextGraph: string;
    directResponse: string;
    contextMessages: any[];
    nodeNumber: any;
    toolParam?: undefined;
} | {
    nextGraph: string;
    contextMessages: any[];
    nodeNumber: any;
    directResponse?: undefined;
    toolParam?: undefined;
} | {
    nextGraph: string;
    toolParam: any;
    contextMessages: any[];
    nodeNumber: any;
    directResponse?: undefined;
}>;
