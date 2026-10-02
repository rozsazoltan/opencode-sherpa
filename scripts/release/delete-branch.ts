const repository = process.env.GITHUB_REPOSITORY ?? "";
const token = process.env.GITHUB_TOKEN ?? "";
const branch = process.env.RELEASE_BRANCH ?? "";
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !token) {
  throw new Error("GitHub repository or token is missing");
}
if (!/^chore\/release-v\d{4}\.(?:0[1-9]|1[0-2])\.[1-9]\d*$/.test(branch)) {
  throw new Error(`Unexpected release branch: ${branch}`);
}

const [owner, repo] = repository.split("/");
const ref = branch.split("/").map(encodeURIComponent).join("/");
const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${ref}`, {
  method: "DELETE",
  headers: {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  },
});

if (response.status === 404) {
  console.log(`Release branch ${branch} was already deleted`);
} else if (!response.ok) {
  throw new Error(`Could not delete ${branch}: GitHub returned HTTP ${response.status} ${await response.text()}`);
} else {
  console.log(`Deleted release branch ${branch}`);
}
