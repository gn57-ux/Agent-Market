import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SignInButton } from "./SignInButton.js";

const login = vi.fn();
const logout = vi.fn();

let mockSession: {
  status: "signed_out" | "signing_in" | "signed_in" | "error";
  address: string | undefined;
  errorMessage: string | undefined;
};

vi.mock("./SessionProvider.js", () => ({
  useSession: () => ({ ...mockSession, login, logout }),
}));

const ADDRESS = "0x1234567890123456789012345678901234567890";

describe("SignInButton", () => {
  it("uses light-canvas tokens by default when signed in", () => {
    mockSession = { status: "signed_in", address: ADDRESS, errorMessage: undefined };
    render(<SignInButton />);

    const addressLabel = screen.getByText(`已登录：${ADDRESS}`);
    expect(addressLabel.className).toContain("text-ink-secondary");
    expect(addressLabel.className).not.toContain("text-ink-muted-on-dark");
  });

  it("uses dark-canvas tokens in the dark variant when signed in (Task E review: homepage hero color coordination)", () => {
    mockSession = { status: "signed_in", address: ADDRESS, errorMessage: undefined };
    render(<SignInButton variant="dark" />);

    const addressLabel = screen.getByText(`已登录：${ADDRESS}`);
    expect(addressLabel.className).toContain("text-ink-muted-on-dark");
    expect(addressLabel.className).not.toContain("text-ink-secondary");

    const logoutButton = screen.getByRole("button", { name: "登出" });
    expect(logoutButton.className).toContain("border-divider-dark");
    expect(logoutButton.className).not.toContain("border-divider-light");
  });
});
