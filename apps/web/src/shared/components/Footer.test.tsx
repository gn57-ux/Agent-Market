import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Footer } from "./Footer.js";

describe("Footer", () => {
  it("renders", () => {
    render(<Footer />);
    expect(screen.getByText(/Agent Market/)).toBeTruthy();
  });
});
