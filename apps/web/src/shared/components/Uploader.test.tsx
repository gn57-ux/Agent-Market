import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Uploader } from "./Uploader.js";

describe("Uploader", () => {
  it("calls onFileSelected with the chosen file", () => {
    const onFileSelected = vi.fn();
    render(<Uploader onFileSelected={onFileSelected} accept="application/pdf" />);

    const input = screen.getByLabelText("上传成果文件") as HTMLInputElement;
    const file = new File(["hello"], "deliverable.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(onFileSelected).toHaveBeenCalledWith(file);
  });

  it("does not call onFileSelected when no file is chosen", () => {
    const onFileSelected = vi.fn();
    render(<Uploader onFileSelected={onFileSelected} />);
    const input = screen.getByLabelText("上传成果文件") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [] } });
    expect(onFileSelected).not.toHaveBeenCalled();
  });
});
