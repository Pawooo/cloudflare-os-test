import { WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { VendorDescription } from "@gadgets/workshop-shared/gatekeeper";

const KINTAI_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
        "<path d='M128 24a104 104 0 1 0 104 104A104.11 104.11 0 0 0 128 24Zm0 192a88 88 0 1 1 88-88 88.1 88.1 0 0 1-88 88Zm40-88a8 8 0 0 1-8 8h-32a8 8 0 0 1-8-8V80a8 8 0 0 1 16 0v40h24a8 8 0 0 1 8 8Z'/></svg>",
    ),
};

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  /** Describes the auto-provisioned Kintai vendor. */
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Kintai",
      url: "https://workers.cloudflare.com/",
      logo: KINTAI_ICON,
      tagline: "Attendance, overtime and approvals",
      description: "Records attendance and routes overtime requests for approval.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }
}
