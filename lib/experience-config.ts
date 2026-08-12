import type { Config } from "@contentful/experiences-react";
import { Button } from "@/components/primitives/Button";
import { Flex } from "@/components/primitives/Flex";
import { Image } from "@/components/primitives/Image";
import { Text } from "@/components/primitives/Text";
import { resolveDesignToken } from "@/lib/design-tokens";

/**
 * The one place that ties the whole pipeline together: registers which React
 * components an Experience can place (keyed by the component name/id set up
 * on the Contentful side — not a decorator or factory call, just a plain map)
 * and how design-token props get resolved for all of them. Passed straight
 * through to `fetchExperience` and `ServerExperienceRenderer` in page.tsx.
 */
export const experienceConfig: Config = {
  components: {
    Button,
    Text,
    Flex,
    Image,
  },
  resolveToken: resolveDesignToken,
};
