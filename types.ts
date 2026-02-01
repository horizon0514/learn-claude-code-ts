declare module "bun" {
    interface Env {
        API_KEY: string;
        BASE_URL: string;
        AI_MODEL: string;
    }
}