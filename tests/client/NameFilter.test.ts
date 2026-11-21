import { describe, expect, it } from "vitest";
import { filterName } from "../../src/client/NameFilter";
import { UserSettings } from "../../src/client/UserSettings";

describe("filterName (viewer profanity filter)", () => {
  const settings = new UserSettings();

  it("masks profanity by default", () => {
    expect(settings.profanityFilter()).toBe(true);
    expect(filterName("fuckface")).toBe("****face");
    expect(filterName("CoolPlayer")).toBe("CoolPlayer");
  });

  it("shows names as typed once the viewer opts out, and masks again after", () => {
    settings.toggleProfanityFilter();
    try {
      expect(settings.profanityFilter()).toBe(false);
      expect(filterName("fuckface")).toBe("fuckface");
    } finally {
      settings.toggleProfanityFilter();
    }
    expect(filterName("fuckface")).toBe("****face");
  });

  it("passes empty and null names through", () => {
    expect(filterName("")).toBe("");
    expect(filterName(null)).toBeNull();
  });
});
