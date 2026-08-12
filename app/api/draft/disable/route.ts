import { draftMode } from "next/headers";
import { redirect } from "next/navigation";

export async function GET(request: Request) {
  const draft = await draftMode();
  draft.disable();

  // Unlike enable/route.ts (hit directly from Contentful's preview config,
  // so it takes an explicit locale/id query param), this route is only ever
  // reached from the "Exit draft mode" button already rendered on the page —
  // so the Referer header is a reliable way back without needing a param.
  const referer = request.headers.get("referer");
  redirect(referer ?? "/");
}
