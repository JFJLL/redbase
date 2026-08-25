import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";

import RemixBrandSelect from "../RemixBrandSelect.vue";

const BRANDS = [
  { id: 1, name: "新途径公考", product: "公考培训", profileType: "brand" },
  { id: 2, name: "产品经理阿林", product: "AI 工作效率", profileType: "personal" },
  { id: 3, name: "小快克", product: "儿童感冒药", profileType: "brand" },
];

describe("RemixBrandSelect", () => {
  it("renders the current subject and opens a branded searchable menu", async () => {
    const wrapper = mount(RemixBrandSelect, {
      props: { modelValue: 1, brands: BRANDS, testId: "remix-brand" },
    });

    expect(wrapper.find('[data-test="remix-brand"]').text()).toContain("新途径公考");
    await wrapper.find('[data-test="remix-brand"]').trigger("click");

    expect(wrapper.find('[data-test="remix-brand-menu"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="remix-brand-search"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="remix-brand-option-2"]').text()).toContain("个人 IP");
  });

  it("filters by brand or product information and emits the chosen subject", async () => {
    const wrapper = mount(RemixBrandSelect, {
      props: { modelValue: 1, brands: BRANDS, testId: "remix-brand" },
    });

    await wrapper.find('[data-test="remix-brand"]').trigger("click");
    await wrapper.find('[data-test="remix-brand-search"]').setValue("儿童");

    expect(wrapper.find('[data-test="remix-brand-option-1"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="remix-brand-option-3"]').exists()).toBe(true);

    await wrapper.find('[data-test="remix-brand-option-3"]').trigger("click");
    expect(wrapper.emitted("update:modelValue")).toEqual([[3]]);
    expect(wrapper.find('[data-test="remix-brand-menu"]').exists()).toBe(false);
  });

  it("supports Escape to close the menu and disabled loading state", async () => {
    const wrapper = mount(RemixBrandSelect, {
      attachTo: document.body,
      props: { modelValue: 1, brands: BRANDS, testId: "remix-brand" },
    });

    await wrapper.find('[data-test="remix-brand"]').trigger("click");
    await wrapper.find('[data-test="remix-brand-search"]').trigger("keydown", { key: "Escape" });
    expect(wrapper.find('[data-test="remix-brand-menu"]').exists()).toBe(false);

    await wrapper.setProps({ disabled: true });
    expect((wrapper.find('[data-test="remix-brand"]').element as HTMLButtonElement).disabled).toBe(true);
    wrapper.unmount();
  });
});
