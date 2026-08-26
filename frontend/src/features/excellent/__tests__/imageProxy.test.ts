import { describe, expect, it } from "vitest";
import { buildExcellentImageProxyPath, excellentImageSrc, isRemoteHttpUrl } from "../imageProxy";

describe("excellent image proxy helpers", () => {
  it("builds same-origin proxy paths from noteId + image index + filters", () => {
    expect(buildExcellentImageProxyPath("n1", 2, { board: "xhs_hot", contentSource: "all" })).toBe(
      "/api/excellent-contents/n1/images/2/file?board=xhs_hot&contentSource=all",
    );
    expect(buildExcellentImageProxyPath("n1", 0, { board: "ecommerce_hot", contentSource: "all" })).toBe(
      "/api/excellent-contents/n1/images/0/file?board=ecommerce_hot&contentSource=all",
    );
    const industryPath = "所属行业#美妆";
    const built = buildExcellentImageProxyPath("n1", 0, {
      board: "ecommerce_hot",
      contentSource: "all",
      industryPath,
    });
    expect(built.startsWith("/api/excellent-contents/n1/images/0/file?board=ecommerce_hot&contentSource=all&industryPath=")).toBe(
      true,
    );
    expect(built).toContain(encodeURIComponent(industryPath));
  });

  it("keeps remote http(s) URLs direct and leaves relative URLs untouched", () => {
    const params = { noteId: "n1", board: "xhs_hot", contentSource: "all" };
    expect(isRemoteHttpUrl("https://cdn.example/1.jpg")).toBe(true);
    expect(isRemoteHttpUrl("http://cdn.example/1.jpg")).toBe(true);
    expect(isRemoteHttpUrl("/img/a.jpg")).toBe(false);
    expect(excellentImageSrc("https://cdn.example/1.jpg", 1, params)).toBe("https://cdn.example/1.jpg");
    expect(excellentImageSrc("/img/a.jpg", 0, params)).toBe("/img/a.jpg");
    expect(excellentImageSrc("", 0, params)).toBe("");
    expect(excellentImageSrc(undefined, 0, params)).toBe("");
  });
});
