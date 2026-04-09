/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      boxShadow: {
        glow: "0 0 0 1px rgba(148,163,184,0.15), 0 20px 60px rgba(0,0,0,0.55)",
        "glow-light":
          "0 0 0 1px rgba(15,23,42,0.08), 0 12px 40px rgba(15,23,42,0.07)",
      },
    },
  },
  plugins: [],
};

