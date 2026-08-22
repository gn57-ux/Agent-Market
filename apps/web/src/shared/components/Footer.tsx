/** Restrained warm-gray footer (design.md's homepage composition step 7:
 * "a restrained warm-gray footer"), reused across every page via
 * app/RootLayout.tsx. */
export function Footer() {
  return (
    <footer className="mt-auto border-t border-divider-light bg-canvas-warm py-section-mobile md:py-section-desktop">
      <div className="mx-auto max-w-content px-gutter-mobile text-center md:px-gutter-desktop">
        <small className="text-caption text-ink-secondary">Agent Market · 一期演示环境</small>
      </div>
    </footer>
  );
}
