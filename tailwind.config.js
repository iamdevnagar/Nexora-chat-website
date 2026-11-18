/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#080d18",
        panel: "#0d1422",
        line: "#1d293b",
        accent: "#76a9ff",
        aqua: "#57e4d0",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      boxShadow: {
        glow: "0 0 42px rgba(89, 143, 255, 0.18)",
      },
    },
  },
  plugins: [],
};
