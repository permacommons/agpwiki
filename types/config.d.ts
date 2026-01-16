declare module 'config' {
  interface ConfigStore {
    get<T = unknown>(setting: string): T;
    has(setting: string): boolean;
  }

  export interface PostgresConfig {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    max: number;
    idleTimeoutMillis: number;
    connectionTimeoutMillis: number;
    allowExitOnIdle?: boolean;
    schema?: string;
  }

  const config: ConfigStore & Record<string, unknown>;
  export default config;
}
