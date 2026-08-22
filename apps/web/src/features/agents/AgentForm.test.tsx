import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AgentForm,
  agentFormValuesFromAgent,
  agentFormValuesToInput,
  emptyAgentFormValues,
  toCreateAgentInput,
} from "./AgentForm.js";

describe("agentFormValuesToInput", () => {
  it("splits and trims the comma-separated skill tags field", () => {
    const values = { ...emptyAgentFormValues(), skillTagsText: " copywriting ,editing,, seo " };
    expect(agentFormValuesToInput(values, emptyAgentFormValues()).skillTags).toEqual([
      "copywriting",
      "editing",
      "seo",
    ]);
  });

  it("create mode (diffing against an empty baseline): a blank optional field is omitted, never null", () => {
    const values = emptyAgentFormValues();
    const input = agentFormValuesToInput(values, emptyAgentFormValues());
    expect(input.authorBio).toBeUndefined();
    expect(input.invocationUrl).toBeUndefined();
    expect(input.pricingModel).toBeUndefined();
    expect(input.referencePrice).toBeUndefined();
  });

  it("edit mode: a field unchanged from the original is omitted (undefined), not resent", () => {
    const original = {
      ...emptyAgentFormValues(),
      authorBio: "Same bio",
      referencePriceText: "9.99",
    };
    const values = { ...original };
    const input = agentFormValuesToInput(values, original);
    expect(input.authorBio).toBeUndefined();
    expect(input.referencePrice).toBeUndefined();
  });

  it("edit mode: clearing a previously-set field sends explicit null, not undefined or empty string (Codex round 1 P2)", () => {
    const original = { ...emptyAgentFormValues(), authorBio: "Had a bio", pricingModel: "flat" };
    const values = { ...original, authorBio: "", pricingModel: "  " };
    const input = agentFormValuesToInput(values, original);
    expect(input.authorBio).toBeNull();
    expect(input.pricingModel).toBeNull();
  });

  it("edit mode: changing a field to a new value sends that value", () => {
    const original = { ...emptyAgentFormValues(), authorBio: "Old bio" };
    const values = { ...original, authorBio: "New bio" };
    expect(agentFormValuesToInput(values, original).authorBio).toBe("New bio");
  });

  it("referencePrice: unchanged text is never re-parsed through Number(), preserving precision (Codex round 1 P2)", () => {
    // A precision-losing value: Number() would round this, but since the
    // text is unchanged from the original, it must never be parsed at all.
    const highPrecisionText = "0.100000000000000000001";
    const original = {
      ...emptyAgentFormValues(),
      referencePriceText: highPrecisionText,
      name: "Old",
    };
    const values = { ...original, name: "New Name" }; // only name changed
    const input = agentFormValuesToInput(values, original);
    expect(input.referencePrice).toBeUndefined();
    expect(input.name).toBe("New Name");
  });

  it("referencePrice: clearing it sends null; changing it sends the parsed number", () => {
    const original = { ...emptyAgentFormValues(), referencePriceText: "10" };
    expect(
      agentFormValuesToInput({ ...original, referencePriceText: "" }, original).referencePrice,
    ).toBeNull();
    expect(
      agentFormValuesToInput({ ...original, referencePriceText: "12.5" }, original).referencePrice,
    ).toBe(12.5);
  });
});

describe("toCreateAgentInput", () => {
  it("maps null/undefined optional fields to undefined for the create request", () => {
    const input = toCreateAgentInput({
      name: "N",
      description: "D",
      category: "C",
      skillTags: ["a"],
      authorBio: null,
      payoutAddress: "0xabc",
    });
    expect(input.authorBio).toBeUndefined();
    expect(input.name).toBe("N");
    expect(input.payoutAddress).toBe("0xabc");
  });
});

describe("agentFormValuesFromAgent", () => {
  it("joins skillTags back into a comma-separated string and maps null to empty string", () => {
    const values = agentFormValuesFromAgent({
      name: "A",
      description: "d",
      category: "writing",
      skillTags: ["a", "b"],
      authorBio: null,
      invocationUrl: null,
      payoutAddress: "0xabc",
      pricingModel: null,
      referencePrice: null,
    });
    expect(values.skillTagsText).toBe("a, b");
    expect(values.authorBio).toBe("");
    expect(values.payoutAddress).toBe("0xabc");
  });
});

describe("AgentForm", () => {
  it("submits the converted input when the form is filled and submitted (create mode, no originalValues)", () => {
    const onSubmit = vi.fn();
    render(
      <AgentForm
        initialValues={emptyAgentFormValues()}
        submitLabel="发布"
        pending={false}
        errorMessage={undefined}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "My Agent" } });
    fireEvent.change(screen.getByLabelText("介绍"), { target: { value: "desc" } });
    fireEvent.change(screen.getByLabelText("分类"), { target: { value: "writing" } });
    fireEvent.change(screen.getByLabelText("收款地址"), {
      target: { value: "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发布" }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "My Agent",
        description: "desc",
        category: "writing",
        payoutAddress: "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3",
      }),
    );
  });

  it("edit mode: submits null for a field the user clears", () => {
    const onSubmit = vi.fn();
    const original = agentFormValuesFromAgent({
      name: "Existing",
      description: "d",
      category: "c",
      skillTags: [],
      authorBio: "Had a bio",
      invocationUrl: null,
      payoutAddress: "0xabc",
      pricingModel: null,
      referencePrice: null,
    });
    render(
      <AgentForm
        initialValues={original}
        originalValues={original}
        submitLabel="保存"
        pending={false}
        errorMessage={undefined}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText("作者介绍"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ authorBio: null }));
  });

  it("shows the error message and disables the submit button while pending", () => {
    render(
      <AgentForm
        initialValues={emptyAgentFormValues()}
        submitLabel="发布"
        pending={true}
        errorMessage="创建失败"
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe("创建失败");
    const submitButton = screen.getByRole("button", { name: "提交中…" }) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);
  });
});
