import { cookies, draftMode } from "next/headers";
import { redirect } from "next/navigation";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get("secret");
  const locale = searchParams.get("locale");
  const id = searchParams.get("id");

  if (secret !== process.env.DRAFT_MODE_SECRET || !locale || !id) {
    return new Response("Invalid token", { status: 401 });
  }

  const draft = await draftMode();
  draft.enable();

  // Next sets __prerender_bypass without SameSite=None, so browsers drop it
  // in a cross-site iframe (e.g. the Contentful preview embed).
  // https://github.com/vercel/next.js/issues/49927
  const cookieStore = await cookies();
  const bypassCookie = cookieStore.get("__prerender_bypass");
  if (bypassCookie) {
    cookieStore.set({
      name: "__prerender_bypass",
      value: bypassCookie.value,
      httpOnly: true,
      path: "/",
      secure: true,
      sameSite: "none",
    });
  }

  redirect(`/${locale}/${id}`);
}
