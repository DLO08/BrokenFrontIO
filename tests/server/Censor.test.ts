import { MAX_USERNAME_LENGTH } from "@openfront/engine-api/Schemas";
import {
  containsProfanity,
  maskHateSpeech,
  maskProfanity,
} from "@openfront/shared/ProfanityFilter";
import { describe, expect, test } from "vitest";
import {
  censorPlayer,
  profanityMatcher,
  shadowNames,
  unshadowApiName,
} from "../../src/server/Censor";

describe("Censor (local fallback)", () => {
  describe("profanityMatcher", () => {
    test("detects exact banned words", () => {
      expect(profanityMatcher.hasMatch("hitler")).toBe(true);
      expect(profanityMatcher.hasMatch("nazi")).toBe(true);
      expect(profanityMatcher.hasMatch("auschwitz")).toBe(true);
      expect(profanityMatcher.hasMatch("nigger")).toBe(true);
      expect(profanityMatcher.hasMatch("nigga")).toBe(true);
      expect(profanityMatcher.hasMatch("chink")).toBe(true);
      expect(profanityMatcher.hasMatch("spic")).toBe(true);
      expect(profanityMatcher.hasMatch("kike")).toBe(true);
      expect(profanityMatcher.hasMatch("faggot")).toBe(true);
      expect(profanityMatcher.hasMatch("retard")).toBe(true);
    });

    test("detects banned words case-insensitively", () => {
      expect(profanityMatcher.hasMatch("Hitler")).toBe(true);
      expect(profanityMatcher.hasMatch("NAZI")).toBe(true);
      expect(profanityMatcher.hasMatch("Adolf")).toBe(true);
      expect(profanityMatcher.hasMatch("NIGGER")).toBe(true);
      expect(profanityMatcher.hasMatch("Nigga")).toBe(true);
      expect(profanityMatcher.hasMatch("FAGGOT")).toBe(true);
      expect(profanityMatcher.hasMatch("Retard")).toBe(true);
    });

    test("detects banned words with leet speak", () => {
      expect(profanityMatcher.hasMatch("h1tl3r")).toBe(true);
      expect(profanityMatcher.hasMatch("4d0lf")).toBe(true);
      expect(profanityMatcher.hasMatch("n4z1")).toBe(true);
      expect(profanityMatcher.hasMatch("n1gg3r")).toBe(true);
      expect(profanityMatcher.hasMatch("f4gg0t")).toBe(true);
      expect(profanityMatcher.hasMatch("r3t4rd")).toBe(true);
    });

    test("detects banned words with duplicated characters", () => {
      expect(profanityMatcher.hasMatch("hiiitler")).toBe(true);
      expect(profanityMatcher.hasMatch("naazzii")).toBe(true);
      expect(profanityMatcher.hasMatch("niiiigger")).toBe(true);
      expect(profanityMatcher.hasMatch("faaggot")).toBe(true);
    });

    test("detects banned words with accented/confusable characters", () => {
      expect(profanityMatcher.hasMatch("Adölf")).toBe(true);
      expect(profanityMatcher.hasMatch("nïgger")).toBe(true);
    });

    test("detects banned words as substrings", () => {
      expect(profanityMatcher.hasMatch("xhitlerx")).toBe(true);
      expect(profanityMatcher.hasMatch("IloveNazi")).toBe(true);
      // Regression: slur + suffix / prefix must be caught
      expect(profanityMatcher.hasMatch("niggertesting")).toBe(true);
      expect(profanityMatcher.hasMatch("testingnigger")).toBe(true);
      expect(profanityMatcher.hasMatch("xnazix")).toBe(true);
      expect(profanityMatcher.hasMatch("faggotry")).toBe(true);
      expect(profanityMatcher.hasMatch("retarded")).toBe(true);
    });

    test("detects banned words with non-alphabetic characters mixed in", () => {
      expect(profanityMatcher.hasMatch("n.i.g.g.e.r")).toBe(true);
      expect(profanityMatcher.hasMatch("hi_tler")).toBe(true);
    });

    test("allows clean usernames", () => {
      expect(profanityMatcher.hasMatch("CoolPlayer")).toBe(false);
      expect(profanityMatcher.hasMatch("GameMaster")).toBe(false);
      expect(profanityMatcher.hasMatch("xXx_Sniper_xXx")).toBe(false);
      expect(profanityMatcher.hasMatch("ProGamer123")).toBe(false);
      expect(profanityMatcher.hasMatch("NightOwl")).toBe(false);
      expect(profanityMatcher.hasMatch("DragonSlayer")).toBe(false);
    });

    test("does not false-positive on words containing banned substrings legitimately", () => {
      // "snigger" is whitelisted in englishDataset
      expect(profanityMatcher.hasMatch("snigger")).toBe(false);
    });

    test("catches kkk as substring", () => {
      expect(profanityMatcher.hasMatch("kkk")).toBe(true);
      expect(profanityMatcher.hasMatch("KKK")).toBe(true);
      expect(profanityMatcher.hasMatch("kkklover")).toBe(true);
      expect(profanityMatcher.hasMatch("ilovekkkboys")).toBe(true);
    });

    test("catches slurs separated by periods (bypass attempt)", () => {
      expect(profanityMatcher.hasMatch("n.i.g.g.e.r")).toBe(true);
      expect(profanityMatcher.hasMatch("N.I.G.G.E.R")).toBe(true);
      expect(profanityMatcher.hasMatch("n.i.g.g.a")).toBe(true);
      expect(profanityMatcher.hasMatch("h.i.t.l.e.r")).toBe(true);
      expect(profanityMatcher.hasMatch("hello n.i.g.g.e.r world")).toBe(true);
    });

    test("censorPlayer masks period-separated slur usernames", () => {
      const masked = censorPlayer("n.i.g.g.e.r", null).username;
      expect(masked).not.toMatch(/[a-z]/i);
      expect(masked).toContain("*");
    });
  });

  describe("masking", () => {
    test("masks only the matched letters", () => {
      expect(maskHateSpeech("xhitlerx")).toBe("x******x");
      expect(maskProfanity("IloveNazi")).toBe("Ilove****");
    });

    test("keeps spaces inside a masked span", () => {
      expect(maskHateSpeech("hi n i g g e r")).toBe("hi * * * * * *");
    });

    test("masks kkk", () => {
      expect(maskHateSpeech("ilovekkkboys")).toBe("ilove***boys");
    });

    test("leaves general profanity to the viewer tier", () => {
      expect(maskHateSpeech("fuck")).toBe("fuck");
      expect(maskProfanity("fuck")).toBe("****");
      expect(containsProfanity("fuck")).toBe(true);
    });

    test("leaves clean names alone", () => {
      for (const name of ["CoolPlayer", "José", "snigger"]) {
        expect(maskProfanity(name), name).toBe(name);
        expect(containsProfanity(name), name).toBe(false);
      }
    });
  });

  describe("censorPlayer", () => {
    test("returns clean usernames unchanged", () => {
      expect(censorPlayer("CoolPlayer", null).username).toBe("CoolPlayer");
      expect(censorPlayer("GameMaster", null).username).toBe("GameMaster");
    });

    test("never hands out a made-up name", () => {
      for (const name of ["hitler", "h1tl3r", "nigger", "fuck", "faggot"]) {
        expect(shadowNames, name).not.toContain(
          censorPlayer(name, null).username,
        );
      }
    });

    test("masks hate terms for everyone", () => {
      expect(censorPlayer("hitler", null).username).toBe("******");
      expect(censorPlayer("h1tl3r", null).username).toBe("******");
      expect(censorPlayer("xXhitlerXx", null).username).toBe("xX******Xx");
    });

    test("passes general profanity through for the viewer's filter", () => {
      // The client masks this unless the viewer has turned the filter off.
      expect(censorPlayer("fuck", null).username).toBe("fuck");
    });

    test("preserves clean clan tag when username is profane", () => {
      const result = censorPlayer("hitler", "COOL");
      expect(result.clanTag).toBe("COOL");
      expect(result.username).toBe("******");
    });

    describe("clan tag censoring", () => {
      test("removes profane clan tag, keeps clean username", () => {
        expect(censorPlayer("CoolPlayer", "NAZI").clanTag).toBeNull();
        expect(censorPlayer("CoolPlayer", "ADOLF").clanTag).toBeNull();
        expect(censorPlayer("CoolPlayer", "HEIL").clanTag).toBeNull();
        expect(censorPlayer("CoolPlayer", "NAZI").username).toBe("CoolPlayer");
      });

      test("removes clan tag that is a slur abbreviation", () => {
        expect(censorPlayer("CoolPlayer", "NIG").clanTag).toBeNull();
        expect(censorPlayer("CoolPlayer", "NIGG").clanTag).toBeNull();
      });

      test("removes clan tag containing full slur (≤5 chars)", () => {
        expect(censorPlayer("CoolPlayer", "NIGGA").clanTag).toBeNull();
        expect(censorPlayer("CoolPlayer", "CHINK").clanTag).toBeNull();
        expect(censorPlayer("CoolPlayer", "SPIC").clanTag).toBeNull();
        expect(censorPlayer("CoolPlayer", "KIKE").clanTag).toBeNull();
      });

      test("removes clan tag with leet speak profanity (≤5 chars)", () => {
        expect(censorPlayer("CoolPlayer", "N4Z1").clanTag).toBeNull();
      });

      test("removes clan tag containing banned word as substring (≤5 chars)", () => {
        expect(censorPlayer("CoolPlayer", "NAZIS").clanTag).toBeNull();
        expect(censorPlayer("CoolPlayer", "HEILS").clanTag).toBeNull();
      });

      test("removes a general-profanity clan tag too", () => {
        expect(censorPlayer("Player", "FUCK").clanTag).toBeNull();
      });

      test("removes [SS] clan tag", () => {
        expect(censorPlayer("Player", "SS").clanTag).toBeNull();
        expect(censorPlayer("Player", "ss").clanTag).toBeNull();
      });

      test("removes [KKK] clan tag", () => {
        expect(censorPlayer("Player", "KKK").clanTag).toBeNull();
      });

      test("keeps clean clan tag when username is clean", () => {
        expect(censorPlayer("Player", "COOL").clanTag).toBe("COOL");
        expect(censorPlayer("Player", "pro").clanTag).toBe("PRO");
      });

      test("removes profane clan tag and masks profane username", () => {
        const result = censorPlayer("hitler", "NAZI");
        expect(result.clanTag).toBeNull();
        expect(result.username).toBe("******");
      });

      describe("clan tag + username combined forms a slur", () => {
        test.each([
          ["HIT", "LER", "***"],
          ["HI", "TLER", "****"],
          ["AD", "OLF", "***"],
          ["NIG", "ger", "***"],
          ["NI", "gger", "****"],
          ["N1G", "g3r", "***"],
        ])(
          "tag %s + name %s drops the tag and masks the name part",
          (tag, name, masked) => {
            const result = censorPlayer(name, tag);
            expect(result.clanTag).toBeNull();
            expect(result.username).toBe(masked);
          },
        );

        test("only the part of the name inside the word is masked", () => {
          expect(censorPlayer("lerFan", "HIT").username).toBe("***Fan");
        });
      });
    });

    // The free-form username charset widened to Latin-1 Supplement and Latin
    // Extended-A. resolveConfusables folds these back to their ASCII letters
    // before matching, so accents are no way past the filter.
    test("accented spellings do not bypass the filter", () => {
      for (const name of ["hïtler", "nâzi", "fàggot", "retàrd", "níggér"]) {
        expect(profanityMatcher.hasMatch(name), name).toBe(true);
        expect(censorPlayer(name, null).username, name).toMatch(/^\*+$/);
      }
      expect(maskProfanity("FÜCK")).toBe("****");
    });

    test("still leaves ordinary accented names alone", () => {
      for (const name of ["José", "Müller", "Łukasz", "Bjørn", "Renée"]) {
        expect(profanityMatcher.hasMatch(name), name).toBe(false);
        expect(censorPlayer(name, null).username, name).toBe(name);
      }
    });

    test("clamps usernames exceeding MAX_USERNAME_LENGTH", () => {
      const longName = "a".repeat(MAX_USERNAME_LENGTH + 7);
      const res = censorPlayer(longName, null);
      expect(res.username).toBe("a".repeat(MAX_USERNAME_LENGTH));
      expect(res.username.length).toBe(MAX_USERNAME_LENGTH);
    });
  });

  describe("unshadowApiName", () => {
    // The API's pick for a flagged name: the one shadow name that
    // unshadowApiName recognises as the replacement for it.
    const shadowFor = (name: string) =>
      shadowNames.find((s) => unshadowApiName(name, s, "LOCAL") !== s);

    test("swaps the API's made-up name for the locally masked one", () => {
      const api = shadowFor("hitler")!;
      expect(api).toBeDefined();
      expect(unshadowApiName("hitler", api, "******")).toBe("******");
    });

    test("masks the whole name when only the API flagged it", () => {
      const api = shadowFor("SomeNovelWord")!;
      expect(unshadowApiName("SomeNovelWord", api, "SomeNovelWord")).toBe(
        "*************",
      );
    });

    test("keeps any other API answer", () => {
      expect(unshadowApiName("CoolPlayer", "CoolPlayer", "CoolPlayer")).toBe(
        "CoolPlayer",
      );
      expect(unshadowApiName("cool", "Cool", "cool")).toBe("Cool");
    });
  });
});
