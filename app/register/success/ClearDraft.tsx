"use client";

import { useEffect } from "react";
import { REGISTRATION_DRAFT_KEY } from "@/lib/types";

/**
 * The entry has been paid for, so the saved form is stale. Without this,
 * navigating home afterwards would show it pre-filled with details that have
 * already been submitted — and invite an accidental duplicate entry.
 */
export default function ClearDraft() {
  useEffect(() => {
    try {
      sessionStorage.removeItem(REGISTRATION_DRAFT_KEY);
    } catch {
      // Storage unavailable; nothing to clean up.
    }
  }, []);

  return null;
}
