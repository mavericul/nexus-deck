/** @type {import('tailwindcss').Config} */
module.exports = {
    darkMode: "class",
    content: ["./src/**/*.{html,js}"],
    theme: {
        extend: {
            colors: {
                brand: {
                    50: "#f0f3ff",
                    500: "#6366f1",
                    600: "#4f46e5",
                    700: "#4338ca",
                    accent: "#06b6d4",
                    neon: "#a855f7",
                },
            },
        },
    },
    plugins: [],
}
