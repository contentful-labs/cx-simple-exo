import { draftMode } from "next/headers";

export default async function Page({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  const { isEnabled: preview } = await draftMode();

  return <>
  {/* Intentional, always-on learning aid — not scaffolding to remove. Lets
      you see the resolved locale/id/preview values while working through
      the exercises, regardless of draft mode. */}
  <div className="flex gap-4 p-2 text-sm bg-blue-300">
    <p><b>Experience ID:</b> {id}</p>
    <p><b>Locale:</b> {locale}</p>
    <p><b>Preview:</b> {preview ? "true" : "false"}</p>
  </div>
  </>;
}
