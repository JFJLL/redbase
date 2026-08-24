import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import CreativeOptionPicker from "../CreativeOptionPicker.vue";
import { XHS_CREATIVE_STYLE_OPTIONS } from "../../api";

describe("CreativeOptionPicker", () => {
  it("renders the summary card with title, current label and description", () => {
    const wrapper = mount(CreativeOptionPicker, {
      props: {
        title: "小红书视觉路线",
        value: "auto",
        options: XHS_CREATIVE_STYLE_OPTIONS,
        testId: "picker-test",
      },
    });

    expect(wrapper.find('[data-test="picker-test-summary"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("小红书视觉路线");
    expect(wrapper.find('[data-test="picker-test-label"]').text()).toBe("智能匹配");
    expect(wrapper.text()).toContain("根据选题内容自动选择更合适的视觉路线");
    expect(wrapper.find('[data-test="picker-test-modal"]').exists()).toBe(false);
  });

  it("opens modal on change button click, renders radio options with semantic fieldset", async () => {
    const wrapper = mount(CreativeOptionPicker, {
      props: {
        title: "小红书视觉路线",
        value: "auto",
        options: XHS_CREATIVE_STYLE_OPTIONS,
        testId: "picker-test",
      },
    });

    await wrapper.find('[data-test="picker-test-change"]').trigger("click");

    const modal = wrapper.find('[data-test="picker-test-modal"]');
    expect(modal.exists()).toBe(true);

    const fieldset = modal.find("fieldset");
    expect(fieldset.exists()).toBe(true);
    expect(fieldset.find("legend").text()).toBe("小红书视觉路线");

    const radioInputs = modal.findAll('input[type="radio"]');
    expect(radioInputs.length).toBe(XHS_CREATIVE_STYLE_OPTIONS.length);

    // auto is checked
    const autoRadio = modal.find('[data-test="picker-test-option-auto"] input')
      .element as HTMLInputElement;
    expect(autoRadio.checked).toBe(true);
  });

  it("selects an option on click, emits update:value, and auto-closes the modal", async () => {
    const wrapper = mount(CreativeOptionPicker, {
      props: {
        title: "小红书视觉路线",
        value: "auto",
        options: XHS_CREATIVE_STYLE_OPTIONS,
        testId: "picker-test",
      },
    });

    await wrapper.find('[data-test="picker-test-summary"]').trigger("click");
    expect(wrapper.find('[data-test="picker-test-modal"]').exists()).toBe(true);

    await wrapper.find('[data-test="picker-test-option-editorial"]').trigger("click");

    expect(wrapper.emitted("update:value")).toEqual([["editorial"]]);
    expect(wrapper.find('[data-test="picker-test-modal"]').exists()).toBe(false);
  });

  it("closes modal on close button click and Escape key", async () => {
    const wrapper = mount(CreativeOptionPicker, {
      props: {
        title: "小红书视觉路线",
        value: "auto",
        options: XHS_CREATIVE_STYLE_OPTIONS,
        testId: "picker-test",
      },
    });

    // Close button
    await wrapper.find('[data-test="picker-test-summary"]').trigger("click");
    expect(wrapper.find('[data-test="picker-test-modal"]').exists()).toBe(true);
    await wrapper.find('[data-test="picker-test-modal-close"]').trigger("click");
    expect(wrapper.find('[data-test="picker-test-modal"]').exists()).toBe(false);

    // Escape key
    await wrapper.find('[data-test="picker-test-summary"]').trigger("click");
    expect(wrapper.find('[data-test="picker-test-modal"]').exists()).toBe(true);
    await wrapper.trigger("keydown", { key: "Escape" });
    expect(wrapper.find('[data-test="picker-test-modal"]').exists()).toBe(false);
  });
});
