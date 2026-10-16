"use client";

import { useEffect, useState } from "react";

import { CALCOM_VERSION, COMPANY_NAME, IS_SELF_HOSTED } from "@calcom/lib/constants";

// eslint-disable-next-line turbo/no-undeclared-env-vars
const vercelCommitHash = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA;
const commitHash = vercelCommitHash ? `-${vercelCommitHash.slice(0, 7)}` : "";
const version = `v.${CALCOM_VERSION}-${!IS_SELF_HOSTED ? "h" : "sh"}`;

// Plain text, no links: the company name and version used to point at go.cal.com, and
// this fork has no equivalent credits or release notes page to send people to instead.
export default function Credits() {
  const [hasMounted, setHasMounted] = useState(false);

  useEffect(() => {
    setHasMounted(true);
  }, []);

  return (
    <small className="text-default mx-3 mb-2 mt-1 hidden text-[0.5rem] opacity-50 lg:block">
      &copy; {new Date().getFullYear()} {COMPANY_NAME} {hasMounted && `${version}${commitHash}`}
    </small>
  );
}
