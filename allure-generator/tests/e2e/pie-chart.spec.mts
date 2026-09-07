import { attachment, description, label, step } from "allure-js-commons";
import { expect, test, type Locator, type Page } from "playwright/test";
import { fixtures, REPORT_MODES } from "./support/fixtures.mts";
import { openReport } from "./support/report.mts";

type Status = "passed" | "failed" | "broken" | "skipped" | "unknown";
const charts = [
  { name: "overview", route: "", selector: ".summary-widget__chart" },
  { name: "status graph", route: "graph", selector: ".status-widget__content" },
];
const scenarios: {
  name: string;
  counts: Partial<Record<Status, number>>;
  rate: string;
  slice?: { status: Status; text: string };
}[] = [
  {
    name: "issue 3489",
    counts: { passed: 493, failed: 45, skipped: 95 },
    rate: "91.63%",
    slice: { status: "passed", text: "493 Passed (77.88% of all tests)" },
  },
  {
    name: "broken and unknown results",
    counts: { passed: 3, failed: 1, broken: 2, skipped: 3, unknown: 1 },
    rate: "50%",
    slice: { status: "broken", text: "2 Broken (20% of all tests)" },
  },
  {
    name: "zero passed results",
    counts: { failed: 1, broken: 1, skipped: 1, unknown: 1 },
    rate: "0%",
    slice: { status: "failed", text: "1 Failed (25% of all tests)" },
  },
  {
    name: "only skipped results",
    counts: { skipped: 3 },
    rate: "0%",
    slice: { status: "skipped", text: "3 Skipped (100% of all tests)" },
  },
  {
    name: "only unknown results",
    counts: { unknown: 2 },
    rate: "0%",
    slice: { status: "unknown", text: "2 Unknown (100% of all tests)" },
  },
  { name: "empty report", counts: {}, rate: "???" },
];

const attachJson = (name: string, value: unknown) =>
  attachment(name, JSON.stringify(value, null, 2), "application/json");

const checkText = async (name: string, locator: Locator, expected: string) => {
  await step(name, async () => {
    try {
      await expect(locator).toHaveText(expected);
    } finally {
      await attachJson(`${name}.json`, {
        expected,
        actual: await locator.textContent().catch(() => null),
      });
    }
  });
};

const checkVisibility = async (name: string, locator: Locator, expected: boolean) => {
  await step(name, async () => {
    try {
      if (expected) {
        await expect(locator).toBeVisible();
      } else {
        await expect(locator).not.toBeVisible();
      }
    } finally {
      await attachJson(`${name}.json`, { expected, actual: await locator.isVisible() });
    }
  });
};

const setResults = async (page: Page, counts: Partial<Record<Status, number>>) => {
  await step("Supply report statistics and status-chart results", async () => {
    const statistic = { passed: 0, failed: 0, broken: 0, skipped: 0, unknown: 0, ...counts };
    const total = Object.values(statistic).reduce((sum, value) => sum + value, 0);
    const summary = { reportName: "Success rate example", statistic: { ...statistic, total } };
    const items = Object.entries(statistic).flatMap(([status, count]) =>
      Array.from({ length: count }, (_, index) => ({ uid: `${status}-${index}`, status })),
    );
    await attachJson("summary.json", summary);
    await attachJson("status-chart.json", items);
    await page.route(/\/widgets\/summary\.json(?:\?.*)?$/, (route) =>
      route.fulfill({ json: summary }),
    );
    await page.route(/\/widgets\/status-chart\.json(?:\?.*)?$/, (route) =>
      route.fulfill({ json: items }),
    );
  });
};

const hoverSlice = async (page: Page, slice: Locator) => {
  // SVG arc bounding-box centers can lie in the doughnut hole. Use a point inside its fill.
  const point = await slice.evaluate((element) => {
    const arc = element as SVGPathElement;
    const box = arc.getBBox();
    const matrix = arc.getScreenCTM();
    if (!matrix) {
      throw new Error("Chart arc has no screen transform");
    }
    for (let x = 1; x < 40; x++) {
      for (let y = 1; y < 40; y++) {
        const candidate = new DOMPoint(box.x + (box.width * x) / 40, box.y + (box.height * y) / 40);
        if (arc.isPointInFill(candidate)) {
          const screen = candidate.matrixTransform(matrix);
          if (document.elementFromPoint(screen.x, screen.y) === arc) {
            return { x: screen.x, y: screen.y };
          }
        }
      }
    }
    throw new Error("No visible point inside chart arc");
  });
  await page.mouse.move(point.x, point.y);
};

const checkAccessibleLabel = async (caption: Locator, expected: string) => {
  await step("Expose only the success-rate label to screen readers", async () => {
    try {
      await expect(caption).toHaveAccessibleName(expected);
      await expect(caption).toHaveAccessibleDescription("");
    } finally {
      await attachJson("accessible-label.json", {
        expected: { name: expected, description: "" },
        actual: await caption.evaluate((element) => ({
          name: element.getAttribute("aria-label"),
          description:
            document.getElementById(element.getAttribute("aria-describedby") || "")?.textContent ||
            "",
        })),
      });
    }
  });
};

test.beforeEach(async () => {
  await label("component", "pie-chart-tooltips");
});

for (const chart of charts) {
  for (const scenario of scenarios) {
    test(`${chart.name}: shows ${scenario.name}`, async ({ page }) => {
      await description(
        `Given ${scenario.name} counts, ${chart.name} shows only a success-rate label and value, with matching accessible text. Slice and legend tooltips show count, status, then the percentage of all tests.`,
      );
      await setResults(page, scenario.counts);
      await step(`Open ${chart.name}`, () =>
        openReport(page, {
          fixture: fixtures.uiDemo.name,
          mode: REPORT_MODES.DIRECTORY,
          route: chart.route,
        }),
      );
      const container = page.locator(chart.selector);
      const caption = container.locator(".chart__caption");
      await checkText("Success-rate caption", caption, scenario.rate);
      await checkAccessibleLabel(caption, `Success rate ${scenario.rate}`);
      await step("Hover success rate", () => caption.hover());
      const tooltip = page.getByRole("tooltip");
      await checkText("Success-rate tooltip", tooltip, `Success rate ${scenario.rate}`);
      await attachment("success-rate-tooltip.png", await page.screenshot(), "image/png");
      await step("Dismiss with Escape", () => page.keyboard.press("Escape"));
      await checkVisibility("Escape hides tooltip", tooltip, false);
      if (scenario.slice) {
        const { status, text } = scenario.slice;
        await step(`Hover ${status} slice`, () =>
          hoverSlice(page, container.locator(`.chart__arc_status_${status}`)),
        );
        await checkText(
          "Slice tooltip label order and percentage",
          page.locator(".tooltip:visible"),
          text,
        );
        if (chart.route === "graph") {
          await step(`Hover ${status} legend`, () =>
            container.locator(`[data-status="${status}"]`).hover(),
          );
          await checkText(
            "Legend tooltip label order and percentage",
            page.locator(".tooltip:visible"),
            text,
          );
        }
      }
    });
  }

  test(`${chart.name}: keyboard, hover, redraw and navigation lifecycle`, async ({ page }) => {
    await description(
      "The success-rate tooltip is reachable with Tab, remains available while hovered or focused, closes on Escape, and is removed on redraw and navigation.",
    );
    await setResults(page, scenarios[0].counts);
    await step(`Open ${chart.name}`, () =>
      openReport(page, {
        fixture: fixtures.uiDemo.name,
        mode: REPORT_MODES.DIRECTORY,
        route: chart.route,
      }),
    );
    const caption = page.locator(`${chart.selector} .chart__caption`);
    const tooltip = page.getByRole("tooltip");
    await step("Reach caption using keyboard", async () => {
      await caption.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      try {
        await expect(caption).toBeFocused();
      } finally {
        await attachJson("keyboard-focus.json", {
          expected: "chart__caption",
          actual: await page.evaluate(() => document.activeElement?.getAttribute("class")),
        });
      }
    });
    await checkVisibility("Focus opens tooltip", tooltip, true);
    await step("Move pointer away while caption stays focused", () => page.mouse.move(0, 0));
    await checkVisibility("Focused tooltip persists", tooltip, true);
    await step("Dismiss focused tooltip", () => page.keyboard.press("Escape"));
    await checkVisibility("Escape hides focused tooltip", tooltip, false);
    await step("Leave caption using keyboard", () => page.keyboard.press("Tab"));
    await checkVisibility("Blur keeps dismissed tooltip hidden", tooltip, false);
    await step("Move pointer from caption into tooltip", async () => {
      await caption.hover();
      await tooltip.hover();
    });
    await checkVisibility("Tooltip remains hoverable", tooltip, true);
    await step("Move pointer outside tooltip", () => page.mouse.move(0, 0));
    await checkVisibility("Pointer exit closes tooltip", tooltip, false);
    await step("Open tooltip then resize chart", async () => {
      await caption.focus();
      await page.setViewportSize({ width: 1280, height: 900 });
    });
    await checkVisibility("Redraw removes tooltip", tooltip, false);
    await step("Open redrawn tooltip", () => caption.focus());
    await checkVisibility("Redrawn caption opens tooltip", tooltip, true);
    await step("Navigate away from chart", () =>
      page.getByRole("link", { name: "Suites", exact: true }).click(),
    );
    await checkVisibility("Navigation removes tooltip", tooltip, false);
  });
}

test("French tooltip places translated status between count and percentage", async ({ page }) => {
  await description(
    "A French report exposes translated success-rate text and places the translated status between the count and percentage for one passed test.",
  );
  await setResults(page, { passed: 1 });
  await page.addInitScript(() => {
    localStorage.setItem("ALLURE_REPORT_SETTINGS", JSON.stringify({ language: "fr" }));
  });
  await step("Open French report", () =>
    openReport(page, { fixture: fixtures.uiDemo.name, mode: REPORT_MODES.DIRECTORY }),
  );
  const caption = page.locator(".summary-widget__chart .chart__caption");
  await step("Hover translated success rate", () => caption.hover());
  await checkText(
    "French success-rate tooltip",
    page.getByRole("tooltip"),
    "Taux de réussite 100%",
  );
  await page.keyboard.press("Escape");
  await step("Hover single passed result", () =>
    hoverSlice(page, page.locator(".summary-widget__chart .chart__arc_status_passed")),
  );
  await checkText(
    "French slice label order and percentage",
    page.locator(".tooltip:visible"),
    "1 Passé (100% de tous les tests)",
  );
});
