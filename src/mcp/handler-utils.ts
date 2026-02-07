export interface McpResource {
  uri: string;
  name: string;
  mimeType?: string;
}

export interface McpResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

export interface McpListResourcesResult {
  resources: McpResource[];
}

export interface McpReadResourceResult {
  contents: McpResourceContents[];
}
