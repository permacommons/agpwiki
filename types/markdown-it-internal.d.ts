declare module 'markdown-it/lib/renderer' {
  import type { Renderer } from 'markdown-it';
  const renderer: typeof Renderer;
  export default renderer;
}

declare module 'markdown-it/lib/token' {
  import type Token from 'markdown-it/lib/token';
  export default Token;
}
