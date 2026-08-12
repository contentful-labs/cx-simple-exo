import { draftMode } from "next/headers";
import { SiteHeader } from "@/components/chrome/SiteHeader";
import { SiteFooter } from "@/components/chrome/SiteFooter";

export default async function ExperienceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Read once here and threaded down as a prop, rather than having every
  // component that cares about draft mode call draftMode() itself.
  const { isEnabled } = await draftMode();

  return (
    <>
      <SiteHeader draftMode={isEnabled} />
      <main>{children}</main>
      <SiteFooter />
    </>
  );
}
