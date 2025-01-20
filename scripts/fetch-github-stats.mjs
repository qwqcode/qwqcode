import { writeFile } from 'node:fs/promises'

const CONFIG = {
  // 重试配置
  retry: {
    maxRetries: 3,
    initialDelay: 1000,
    maxDelay: 5000
  },
  
  // 日志配置
  logging: {
    level: 'INFO', // DEBUG, INFO, WARN, ERROR
    format: {
      debug: '[DEBUG]',
      info: '[INFO]',
      warn: '[WARN]',
      error: '[ERROR]'
    }
  },
  
  // API 配置
  api: {
    github: {
      baseUrl: 'https://api.github.com',
      userAgent: 'GitHub-Stats-Bot'
    },
    npm: {
      registryUrl: 'https://registry.npmjs.org',
      downloadsApi: 'https://api.npmjs.org/downloads'
    },
    dockerHub: {
      baseUrl: 'https://hub.docker.com/v2'
    }
  },
  
  // 仓库配置
  repos: [
    {
      repo: 'ArtalkJS/Artalk',
      packages: {
        npm: 'artalk',
        docker: 'artalk/artalk-go',
        github_releases: true
      }
    },
    {
      user: 'qwqcode',
      packages: {
        github_releases: true
      }
    }
  ],
  
  // 输出配置
  output: {
    path: 'json/qwqcode-repos.json',
    indent: 2
  }
};

// 日志级别映射
const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

// 日志工具
const logger = {
  level: LOG_LEVELS[CONFIG.logging.level],
  debug: (...args) => logger.level <= LOG_LEVELS.DEBUG && console.log(CONFIG.logging.format.debug, ...args),
  info: (...args) => logger.level <= LOG_LEVELS.INFO && console.log(CONFIG.logging.format.info, ...args),
  warn: (...args) => logger.level <= LOG_LEVELS.WARN && console.warn(CONFIG.logging.format.warn, ...args),
  error: (...args) => logger.level <= LOG_LEVELS.ERROR && console.error(CONFIG.logging.format.error, ...args)
};

// 重试工具函数
async function withRetry(fn, options = {}) {
  const { maxRetries, initialDelay, maxDelay } = { ...CONFIG.retry, ...options };
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries) break;
      
      const delay = Math.min(initialDelay * Math.pow(2, attempt - 1), maxDelay);
      logger.warn(`Attempt ${attempt} failed, retrying in ${delay}ms:`, error.message);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}

async function fetchGitHub(path) {
  return withRetry(async () => {
    const url = `${CONFIG.api.github.baseUrl}${path}`;
    logger.debug(`Fetching GitHub API: ${url}`);
    const response = await fetch(url, {
      headers: {
        'User-Agent': CONFIG.api.github.userAgent,
        'Authorization': `token ${process.env.GITHUB_TOKEN}`
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API error (${response.status}): ${text}`);
    }

    // 检查 rate limit
    const rateLimit = {
      remaining: response.headers.get('x-ratelimit-remaining'),
      reset: response.headers.get('x-ratelimit-reset')
    };
    
    if (rateLimit.remaining === '0') {
      const resetDate = new Date(rateLimit.reset * 1000);
      logger.warn(`GitHub API rate limit reached, resets at ${resetDate.toISOString()}`);
    }

    return response.json();
  });
}

async function fetchNpmStats(packageName) {
  return withRetry(async () => {
    logger.debug(`Fetching NPM stats for ${packageName}`);
    try {
      // 获取包的发布信息
      const pkgResponse = await fetch(`${CONFIG.api.npm.registryUrl}/${packageName}`);
      if (!pkgResponse.ok) {
        throw new Error(`NPM registry error (${pkgResponse.status}): ${await pkgResponse.text()}`);
      }
      const pkgInfo = await pkgResponse.json();
      const firstVersion = Object.keys(pkgInfo.time).find(v => v !== 'created' && v !== 'modified');
      if (!firstVersion) {
        throw new Error(`No versions found for package ${packageName}`);
      }
      const startDate = pkgInfo.time[firstVersion];
      
      // 并行获取月度和总下载量
      const [monthlyStats, totalStats] = await Promise.all([
        (async () => {
          const res = await fetch(`${CONFIG.api.npm.downloadsApi}/point/last-month/${packageName}`);
          if (!res.ok) throw new Error(`NPM downloads API error: ${await res.text()}`);
          return res.json();
        })(),
        (async () => {
          const res = await fetch(
            `${CONFIG.api.npm.downloadsApi}/range/${startDate.slice(0,10)}:${new Date().toISOString().slice(0,10)}/${packageName}`
          );
          if (!res.ok) throw new Error(`NPM downloads API error: ${await res.text()}`);
          return res.json();
        })()
      ]);
      
      return {
        downloads_last_month: monthlyStats.downloads,
        downloads_total: totalStats.downloads.reduce((sum, day) => sum + day.downloads, 0),
        first_published: startDate,
        latest_version: pkgInfo['dist-tags']?.latest
      };
    } catch (error) {
      logger.error(`Failed to fetch NPM stats for ${packageName}:`, error);
      throw error;
    }
  });
}

async function fetchDockerHubStats(image) {
  const response = await fetch(`${CONFIG.api.dockerHub.baseUrl}/repositories/${image}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch Docker Hub stats: ${await response.text()}`);
  }
  return response.json();
}

async function fetchGitHubReleaseStats(repo) {
  const releases = await fetchGitHub(`/repos/${repo}/releases`);
  let totalDownloads = 0;
  let latestRelease = null;

  for (const release of releases) {
    // 计算每个 release 的所有 assets 下载总和
    const releaseDownloads = release.assets.reduce((sum, asset) => sum + asset.download_count, 0);
    totalDownloads += releaseDownloads;

    // 记录最新的 release
    if (!release.prerelease && !release.draft) {
      if (!latestRelease || new Date(release.published_at) > new Date(latestRelease.published_at)) {
        latestRelease = {
          tag_name: release.tag_name,
          published_at: release.published_at,
          downloads: releaseDownloads
        };
      }
    }
  }

  return {
    total_downloads: totalDownloads,
    latest_release: latestRelease
  };
}

function formatNumber(num) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toString();
}

const LANG_COLORS = {
  "JavaScript": "#f1e05a",
  "TypeScript": "#3178c6",
  "Python": "#3572A5",
  "Java": "#b07219",
  "Go": "#00ADD8",
  "PHP": "#4F5D95",
  "C++": "#f34b7d",
  "C": "#555555",
  "Ruby": "#701516",
  "Shell": "#89e051",
  "HTML": "#e34c26",
  "CSS": "#563d7c",
  "Vue": "#41b883",
  "Rust": "#dea584",
  "Swift": "#ffac45",
  "Kotlin": "#A97BFF",
  "Dart": "#00B4AB",
  "C#": "#178600",
  "Jupyter Notebook": "#DA5B0B",
  "Assembly": "#6E4C13",
  "Objective-C": "#438eff",
  "Scala": "#c22d40",
  "R": "#198CE7",
  "Lua": "#000080",
  "Haskell": "#5e5086",
  "SCSS": "#c6538c",
  "Less": "#1d365d",
  "Stylus": "#ff6347",
  "Perl": "#0298c3",
  "CoffeeScript": "#244776",
  "Elixir": "#6e4a7e",
  "Clojure": "#db5855",
  "Erlang": "#B83998",
  "Julia": "#a270ba",
  "Elm": "#60B5CC",
  "OCaml": "#3be133",
  "MATLAB": "#e16737",
  "Groovy": "#e69f56",
  "Fortran": "#4d41b1",
  "Haxe": "#df7900",
  "Pascal": "#E3F171",
  "Assembly": "#6E4C13",
  "PowerShell": "#012456",
  "Visual Basic": "#945db7",
  "Dockerfile": "#384d54",
  "CMake": "#DA3434",
  "Makefile": "#427819",
  "Markdown": "#083fa1",
  "YAML": "#cb171e",
  "JSON": "#292929",
  "XML": "#0060ac",
  "Vim script": "#199f4b",
  "Svelte": "#ff3e00",
  "Astro": "#ff5a03",
  "Zig": "#ec915c",
  "Nix": "#7e7eff"
};

function formatRepo(repo) {
  return {
    name: repo.name,
    full_name: repo.full_name,
    description: repo.description,
    url: repo.html_url,
    homepage: repo.homepage,
    language: repo.language,
    language_color: repo.language ? LANG_COLORS[repo.language] || null : null,
    stats: {
      stars: repo.stargazers_count,
      stars_fmt: formatNumber(repo.stargazers_count),
      forks: repo.forks_count,
      forks_fmt: formatNumber(repo.forks_count),
      watchers: repo.watchers_count,
      watchers_fmt: formatNumber(repo.watchers_count),
      issues: repo.open_issues_count,
      issues_fmt: formatNumber(repo.open_issues_count),
      size: repo.size,
      size_fmt: formatNumber(repo.size)
    },
    dates: {
      created_at: repo.created_at,
      updated_at: repo.updated_at,
      pushed_at: repo.pushed_at
    },
    is_fork: repo.fork,
    is_archived: repo.archived,
    is_template: repo.is_template,
    license: repo.license?.spdx_id === 'NOASSERTION' ? null : repo.license?.spdx_id || null,
    license_url: repo.license?.url || null,
    topics: repo.topics || []
  }
}

async function fetchRepoStats(repoFullName, packages = {}) {
  const [repoData, releaseStats] = await Promise.all([
    fetchGitHub(`/repos/${repoFullName}`),
    packages.github_releases ? fetchGitHubReleaseStats(repoFullName) : null
  ]);

  // 获取额外的包统计
  let packageStats = {};

  if (packages) {
    const promises = [];
    const stats = {};

    if (packages.npm) {
      promises.push(
        fetchNpmStats(packages.npm)
          .then(npmStats => {
            stats.npm = {
              name: packages.npm,
              url: `https://www.npmjs.com/package/${packages.npm}`,
              downloads_last_month: npmStats.downloads_last_month,
              downloads_last_month_fmt: formatNumber(npmStats.downloads_last_month),
              downloads_total: npmStats.downloads_total,
              downloads_total_fmt: formatNumber(npmStats.downloads_total),
              first_published: npmStats.first_published,
              latest_version: npmStats.latest_version
            };
          })
      );
    }

    if (packages.docker) {
      promises.push(
        fetchDockerHubStats(packages.docker)
          .then(dockerStats => {
            stats.docker = {
              name: packages.docker,
              url: `https://hub.docker.com/r/${packages.docker}`,
              pull_count: dockerStats.pull_count,
              pull_count_fmt: formatNumber(dockerStats.pull_count),
              star_count: dockerStats.star_count,
              star_count_fmt: formatNumber(dockerStats.star_count)
            };
          })
      );
    }

    if (promises.length > 0) {
      await Promise.all(promises);
      packageStats = stats;
    }

    if (packages.github_releases && releaseStats) {
      packageStats.github_releases = {
        url: `https://github.com/${repoFullName}/releases`,
        total_downloads: releaseStats.total_downloads,
        total_downloads_fmt: formatNumber(releaseStats.total_downloads),
        latest_release: {
          ...releaseStats.latest_release,
          downloads_fmt: formatNumber(releaseStats.latest_release?.downloads || 0)
        }
      };
    }
  }

  return {
    ...formatRepo(repoData),
    package_stats: packageStats
  };
}

async function main() {
  try {
    logger.info('Starting GitHub stats collection...');
    
    // 获取所有仓库数据
    logger.info('Fetching repos data...');
    const reposPromises = [];

    for (const repoConfig of CONFIG.repos) {
      if (repoConfig.repo) {
        // 获取单个仓库数据
        reposPromises.push(
          fetchRepoStats(repoConfig.repo, repoConfig.packages)
            .catch(error => {
              logger.error(`Failed to fetch stats for ${repoConfig.repo}:`, error);
              return null;
            })
        );
      } else if (repoConfig.user) {
        // 获取用户的所有非fork仓库
        reposPromises.push(
          fetchGitHub(`/users/${repoConfig.user}/repos?per_page=100&sort=updated`)
            .then(repos => 
              Promise.all(
                repos
                  .filter(repo => !repo.fork)
                  .map(repo => {
                    const fullName = `${repoConfig.user}/${repo.name}`;
                    return fetchRepoStats(fullName, repoConfig.packages)
                      .catch(error => {
                        logger.error(`Failed to fetch stats for ${fullName}:`, error);
                        return null;
                      });
                  })
              )
            )
            .catch(error => {
              logger.error(`Failed to fetch repos for user ${repoConfig.user}:`, error);
              return [];
            })
        );
      }
    }

    const reposResults = await Promise.all(reposPromises);
    const allRepos = reposResults
      .flat()
      .filter(repo => repo !== null)
      .sort((a, b) => b.stats.stars - a.stats.stars);
    
    const totalStars = allRepos.reduce((sum, repo) => sum + repo.stats.stars, 0);
    
    const result = {
      generated_at: new Date().toISOString(),
      total_stars: totalStars,
      total_stars_fmt: formatNumber(totalStars),
      total_repos: allRepos.length,
      total_repos_fmt: formatNumber(allRepos.length),
      repos: Object.fromEntries(
        allRepos.map(repo => [repo.full_name, repo])
      )
    };

    logger.info(`Writing results to file (${allRepos.length} repos, ${totalStars} stars)...`);
    await writeFile(
      CONFIG.output.path,
      JSON.stringify(result, null, CONFIG.output.indent)
    );
    
    logger.info('GitHub stats collection completed successfully!');
  } catch (error) {
    logger.error('Fatal error:', error);
    process.exit(1);
  }
}

main(); 