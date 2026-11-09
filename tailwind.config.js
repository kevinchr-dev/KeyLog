/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./views/**/*.ejs'],
  theme: {
    extend: {
      colors: {
        ink: '#10283f',
        navy: '#09213a',
        gold: '#916a2a',
        mist: '#f2f6f9',
        sky: '#e8f1f7',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
      },
      boxShadow: {
        soft: '0 20px 60px rgba(16, 40, 63, 0.08)',
      },
    },
  },
  plugins: [],
};
