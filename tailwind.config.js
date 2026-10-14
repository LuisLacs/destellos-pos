/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'destellos-pink': '#FDF3F6',
        'destellos-lilac': '#D8C3E5',
        'destellos-gold': '#D4AF37',
        'destellos-dark': '#333333',
      }
    },
  },
  plugins: [],
}