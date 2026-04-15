declare module 'ponder' {
  export const createConfig: any;
  export const createSchema: any;
  export type Context = any;
}

// Fallback for environments where Node types are not resolved during linting
declare const process: any;


