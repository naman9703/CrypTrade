/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      boxShadow: {
        glow: "0 0 0 1px rgba(148,163,184,0.15), 0 20px 60px rgba(0,0,0,0.55)",
      },
    },
  },
  plugins: [],
};

