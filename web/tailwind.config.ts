import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "hsl(240 10% 6%)",
        foreground: "hsl(0 0% 98%)",
        muted: "hsl(240 5% 15%)",
        accent: "hsl(174 72% 56%)",
        border: "hsl(240 5% 20%)",
      },
    },
  },
  plugins: [],
} satisfies Config;
