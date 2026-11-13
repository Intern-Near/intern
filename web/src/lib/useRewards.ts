import { getChain, useDesk } from "../chain/store";
import type { Rewards } from "../chain/types";
import { useAsync } from "./useAsync";

/** The reward ladder's numbers (interface 1.4), re-read whenever the feed grows. Null until they arrive or if the program has none. */
export function useRewards(): Rewards | null {
  const { desk } = useDesk();
  const seq = desk?.feed[desk.feed.length - 1]?.seq ?? 0;
  return useAsync(() => getChain().getRewards(), `rewards-${seq}`).data;
}
