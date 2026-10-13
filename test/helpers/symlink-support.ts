import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function unavailable(): boolean {
	if (process.platform !== "win32") return false;
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-profile-file-link-probe-"));
	try {
		const target = path.join(root, "target");
		fs.writeFileSync(target, "probe");
		fs.symlinkSync(target, path.join(root, "link"), "file");
		return false;
	} catch (error) {
		if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return true;
		throw error;
	} finally {
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
	}
}
// File links require privilege/developer mode; directory links use junctions.
export const fileSymlinkUnavailable = unavailable();
