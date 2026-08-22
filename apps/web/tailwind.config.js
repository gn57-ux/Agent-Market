/**
 * Design tokens transcribed 1:1 from docs/stitch_agent_market_landing_page 2/design.md
 * (this project's "唯一视觉规范" per its own usage notes) — nothing added
 * beyond what that file specifies. Stitch's own per-screen exports add many
 * more auto-derived Material-3 auxiliary tokens (surface-container-high/low,
 * on-tertiary-*, etc.); those are NOT part of the design system design.md
 * defines, so they are deliberately not imported here (CLAUDE.md 原则: 不要
 * 为视觉实现增加不必要的抽象层 — every extra token is one more thing to keep in
 * sync with no canonical source of truth).
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        "canvas-light": "#FFFFFF",
        "canvas-warm": "#F5F5F7",
        "surface-light": "#FAFAFC",
        "canvas-dark": "#000000",
        "surface-dark": "#161617",
        "surface-dark-raised": "#242426",
        "ink-primary": "#1D1D1F",
        "ink-secondary": "#6E6E73",
        "ink-on-dark": "#F5F5F7",
        "ink-muted-on-dark": "#A1A1A6",
        "action-blue": "#0071E3",
        "action-blue-on-dark": "#2997FF",
        success: "#248A3D",
        warning: "#C93400",
        "divider-light": "#D2D2D7",
        "divider-dark": "#3A3A3C",
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "SF Pro Display",
          "PingFang SC",
          "Inter",
          "system-ui",
          "sans-serif",
        ],
      },
      fontSize: {
        hero: ["64px", { lineHeight: "1.05", fontWeight: "600", letterSpacing: "-0.03em" }],
        "hero-mobile": [
          "40px",
          { lineHeight: "1.08", fontWeight: "600", letterSpacing: "-0.03em" },
        ],
        display: ["48px", { lineHeight: "1.1", fontWeight: "600", letterSpacing: "-0.025em" }],
        "display-mobile": [
          "32px",
          { lineHeight: "1.15", fontWeight: "600", letterSpacing: "-0.025em" },
        ],
        title: ["28px", { lineHeight: "1.2", fontWeight: "600" }],
        lead: ["21px", { lineHeight: "1.45", fontWeight: "400" }],
        body: ["17px", { lineHeight: "1.6", fontWeight: "400" }],
        caption: ["14px", { lineHeight: "1.45", fontWeight: "400" }],
      },
      maxWidth: {
        content: "1200px",
        reading: "760px",
      },
      spacing: {
        "gutter-desktop": "32px",
        "gutter-mobile": "20px",
        "section-desktop": "120px",
        "section-mobile": "72px",
      },
      borderRadius: {
        control: "999px",
        card: "28px",
        "card-compact": "18px",
        input: "14px",
      },
    },
  },
  plugins: [],
};
