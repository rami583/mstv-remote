import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
    "./src/lib/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        ink: "#07111f",
        steel: "#102339",
        signal: "#f7b500",
        tally: "#ff5a36",
        air: "#8df0cc"
      },
      boxShadow: {
        panel: "0 18px 48px rgba(0, 0, 0, 0.18)"
      },
      backgroundImage: {
        "control-grid":
          "linear-gradient(rgba(141, 240, 204, 0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(141, 240, 204, 0.08) 1px, transparent 1px)"
      }
    }
  },
  plugins: []
};

export default config;
