/* eslint-disable playwright/missing-playwright-await */
import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import Credits from "./Credits";

vi.mock("@calcom/lib/constants", async () => {
  const actual = (await vi.importActual("@calcom/lib/constants")) as typeof import("@calcom/lib/constants");
  return {
    ...actual,
    CALCOM_VERSION: "mockedVersion",
    // Pinned so local NEXT_PUBLIC_COMPANY_NAME branding cannot change the assertions below.
    COMPANY_NAME: "Cal.com, Inc.",
  };
});

describe("Tests for Credits component", () => {
  test("Should render credits section with links", () => {
    render(<Credits />);

    const creditsLinkElement = screen.getByRole("link", { name: /Cal\.com, Inc\./i });
    expect(creditsLinkElement).toBeInTheDocument();
    expect(creditsLinkElement).toHaveAttribute("href", "https://go.cal.com/credits");

    const versionLinkElement = screen.getByRole("link", { name: /mockedVersion/i });
    expect(versionLinkElement).toBeInTheDocument();
    expect(versionLinkElement).toHaveAttribute("href", "https://go.cal.com/releases");
  });

  test("Should render credits section with correct text", () => {
    render(<Credits />);

    const currentYear = new Date().getFullYear();
    const copyrightElement = screen.getByText(`© ${currentYear}`);
    expect(copyrightElement).toHaveTextContent(`${currentYear}`);
  });
});
