import type { Config } from "tailwindcss";
import path from "path";

const config: Config = {
    content: [
        path.join(__dirname, "./src/**/*.{js,ts,jsx,tsx,mdx}"),
        path.join(__dirname, "../../packages/shared-ui/src/**/*.{js,ts,jsx,tsx,mdx}")
    ],
    theme: {
        extend: {},
    },
    plugins: [],
};
export default config;
