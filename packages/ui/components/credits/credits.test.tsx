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
    COMPANY_NAME: "Lavela Health",
  };
});

describe("Tests for Credits component", () => {
  test("Should render the company name and version as plain text", () => {
    render(<Credits />);

    expect(screen.getByText(/Lavela Health/)).toBeInTheDocument();
    expect(screen.getByText(/mockedVersion/)).toBeInTheDocument();
  });

  test("Should not link out to cal.com", () => {
    render(<Credits />);

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  test("Should render credits section with correct text", () => {
    render(<Credits />);

    const currentYear = new Date().getFullYear();
    expect(screen.getByText(new RegExp(`${currentYear}`))).toBeInTheDocument();
  });
});
