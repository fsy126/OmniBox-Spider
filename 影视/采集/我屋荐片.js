// ==UserScript==
// @name         荐片APP
// @namespace    https://omnibox.pro/
// @version      1.1.2
// @description  荐片APP爬虫脚本，支持首页推荐、Netflix专区、分类筛选、搜索、详情及播放功能，自动过滤FTP/边下边播/VIP无效线路
// @author       OmniBox
// ==/UserScript==

const OmniBox = require("omnibox_sdk");

const jpConfig = {
  host: 'https://api.zxfmj.com',
  fallbackHosts: [
    'https://api.zxfmj.com',
    'https://h5.jianpianips1.com'
  ],
  imgHost: 'https://img.ztfgh.com',
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Origin': 'https://api.zxfmj.com',
    'Referer': 'https://api.zxfmj.com/'
  }
};

// 需要屏蔽的无效线路关键词（不区分大小写）
const BLOCKED_SOURCE_KEYWORDS = ['vip', 'ftp', '边下边播'];

/**
 * 判断线路名称是否需要被屏蔽
 */
function shouldBlockSource(sourceName) {
  if (!sourceName) return false;
  const lower = String(sourceName).toLowerCase().trim();
  for (const kw of BLOCKED_SOURCE_KEYWORDS) {
    if (lower.includes(kw)) {
      return true;
    }
  }
  if (lower === '常规线路' || lower === '常规') {
    return true;
  }
  return false;
}

/**
 * 判断播放链接是否属于需要屏蔽的协议或地址
 */
function shouldBlockUrl(url) {
  if (!url) return true;
  const lower = String(url).toLowerCase().trim();
  return lower.startsWith('ftp://') || lower.startsWith('thunder://') || lower.startsWith('magnet:');
}

/**
 * 发起HTTP请求（带备用域名切换）
 */
async function request(url, options = {}) {
  const tryRequest = async (targetUrl, hostOrigin) => {
    const reqHeaders = {
      ...jpConfig.headers,
      ...(hostOrigin ? { Origin: hostOrigin, Referer: `${hostOrigin}/` } : {}),
      ...(options.headers || {})
    };
    const response = await OmniBox.request(targetUrl, {
      method: options.method || 'GET',
      headers: reqHeaders,
      body: options.body,
      timeout: options.timeout || 15000
    });
    if (response.statusCode !== 200) {
      throw new Error(`HTTP ${response.statusCode}: ${targetUrl}`);
    }
    if (!response.body) {
      throw new Error('响应体为空');
    }
    return JSON.parse(response.body);
  };

  try {
    return await tryRequest(url);
  } catch (err) {
    // 仅当请求当前主host失败时尝试备用host
    if (url.startsWith(jpConfig.host)) {
      for (const altHost of jpConfig.fallbackHosts) {
        if (altHost === jpConfig.host) continue;
        try {
          const altUrl = url.replace(jpConfig.host, altHost);
          const data = await tryRequest(altUrl, altHost);
          jpConfig.host = altHost;
          jpConfig.headers.Origin = altHost;
          jpConfig.headers.Referer = `${altHost}/`;
          await OmniBox.log('info', `已自动切换可用域名: ${altHost}`);
          return data;
        } catch (altErr) {
          await OmniBox.log('warn', `备用域名请求失败 [${altHost}]: ${altErr.message}`);
        }
      }
    }
    await OmniBox.log('error', `请求失败 [${url}]: ${err.message}`);
    throw err;
  }
}

/**
 * 处理图片URL
 */
function fixPicUrl(pic) {
  if (!pic) return '';
  if (pic.startsWith('http://') || pic.startsWith('https://')) {
    return pic;
  }
  return pic.startsWith('/') ? `${jpConfig.imgHost}${pic}` : `${jpConfig.imgHost}/${pic}`;
}

/**
 * 构建视频ID（包含基本信息以便详情页直接使用）
 */
function buildVodId(item) {
  const id = item.id || item.vod_id;
  return String(id);
}

/**
 * 解析视频列表项
 */
function parseVodItem(item) {
  const pic = fixPicUrl(item.path || item.tvimg || item.tagimg || item.thumbnail || '');
  const title = item.title || item.name || '未知标题';
  let remarks = item.mask || '';
  if (!remarks && item.score && Number(item.score) > 0) {
    remarks = `${item.score}分`;
  }
  return {
    vod_id: buildVodId(item),
    vod_name: title,
    vod_pic: pic,
    vod_remarks: remarks
  };
}

/**
 * 获取首页数据（分类与推荐内容）
 */
async function getHomeContent() {
  try {
    const classes = [];
    const filters = {};

    // 1. 获取分类列表
    const catRes = await request(`${jpConfig.host}/api/v2/settings/homeCategory`);
    if (catRes.code === 1 && Array.isArray(catRes.data)) {
      for (const cat of catRes.data) {
        let typeId = String(cat.id);
        const typeName = cat.name;

        // 跳过“首页”标签，使用独立recommend接口
        if (cat.id === 88 || typeName === '首页') {
          continue;
        }

        // Netflix 特殊分类标识
        if (cat.id === 99 || String(typeName).toLowerCase().includes('netflix')) {
          typeId = 'netflix';
        }

        classes.push({
          type_id: typeId,
          type_name: typeName
        });

        // 为普通分类获取筛选条件
        if (typeId !== 'netflix') {
          try {
            const filterRes = await request(`${jpConfig.host}/api/crumb/filterOptions?fcate_pid=${typeId}`);
            if (filterRes.code === 1 && Array.isArray(filterRes.data)) {
              const catFilters = [];
              const filterNameMap = {
                'type': '类型',
                'area': '地区',
                'year': '年份',
                'sort': '排序'
              };
              for (const f of filterRes.data) {
                if (Array.isArray(f.data) && f.data.length > 0) {
                  catFilters.push({
                    key: f.key,
                    name: filterNameMap[f.key] || f.key,
                    init: '',
                    value: f.data.map(opt => ({
                      name: opt.name,
                      value: String(opt.id)
                    }))
                  });
                }
              }
              if (catFilters.length > 0) {
                filters[typeId] = catFilters;
              }
            }
          } catch (e) {
            await OmniBox.log('warn', `获取分类 ${typeName} 筛选条件失败: ${e.message}`);
          }
        }
      }
    }

    // 如果包含 netflix 分类，添加筛选子项（与普通分类格式保持一致）
    if (classes.some(c => c.type_id === 'netflix')) {
      filters['netflix'] = [
        {
          key: 'sub_type',
          name: '分类',
          init: 'hot_movie',
          value: [
            { name: '热门电影', value: 'hot_movie' },
            { name: '经典合集', value: 'classic_movie' },
            { name: '独家剧集', value: 'exclusive_series' }
          ]
        }
      ];
    }

    // 2. 获取首页推荐数据
    let list = [];
    const recRes = await request(`${jpConfig.host}/api/dyTag/hand_data?category_id=88`);
    if (recRes.code === 1 && recRes.data) {
      const seenIds = new Set();
      for (const key of Object.keys(recRes.data)) {
        const group = recRes.data[key];
        if (Array.isArray(group)) {
          for (const item of group) {
            if (item && item.id && !seenIds.has(item.id)) {
              seenIds.add(item.id);
              list.push(parseVodItem(item));
            }
          }
        }
      }
    }

    return {
      class: classes,
      filters: filters,
      list: list
    };
  } catch (error) {
    await OmniBox.log('error', `获取首页数据失败: ${error.message}`);
    return { class: [], filters: {}, list: [] };
  }
}

/**
 * 获取分类下的视频列表
 */
async function getCategoryList(tid, pg = 1, extend = {}) {
  try {
    // 处理 Netflix 专区
    if (tid === 'netflix') {
      return await getNetflixList(pg, extend);
    }

    // 普通分类筛选
    const categoryId = extend.category_id || '';
    const area = extend.area || '';
    const year = extend.year || '';
    const type = extend.type || '';
    const sort = extend.sort || '';

    const url = `${jpConfig.host}/api/crumb/list?fcate_pid=${tid}&page=${pg}&category_id=${categoryId}&area=${area}&year=${year}&type=${type}&sort=${sort}`;
    const res = await request(url);

    let list = [];
    if (res.code === 1 && Array.isArray(res.data)) {
      list = res.data.map(parseVodItem);
    }

    return {
      page: Number(pg),
      pagecount: list.length >= 15 ? Number(pg) + 1 : Number(pg),
      limit: 15,
      total: 9999,
      list: list
    };
  } catch (error) {
    await OmniBox.log('error', `获取分类列表失败 [${tid}]: ${error.message}`);
    return { page: Number(pg), pagecount: 1, limit: 15, total: 0, list: [] };
  }
}

/**
 * 获取 Netflix 专区数据
 */
async function getNetflixList(pg = 1, extend = {}) {
  try {
    const subType = extend.sub_type || 'hot_movie';
    let url = '';
    if (subType === 'hot_movie') {
      url = `${jpConfig.host}/api/dyTag/tpl1_data?id=70&page=${pg}`;
    } else if (subType === 'classic_movie') {
      if (Number(pg) > 1) {
        return { page: Number(pg), pagecount: 1, limit: 20, total: 0, list: [] };
      }
      url = `${jpConfig.host}/api/special/detail?id=134`;
    } else if (subType === 'exclusive_series') {
      url = `${jpConfig.host}/api/dyTag/tpl1_data?id=71&page=${pg}`;
    } else {
      url = `${jpConfig.host}/api/dyTag/tpl1_data?id=70&page=${pg}`;
    }

    const res = await request(url);
    let list = [];
    if (res.code === 1 && res.data) {
      const items = Array.isArray(res.data)
        ? res.data
        : (res.data.list || res.data.video || []);
      list = items.map(parseVodItem);
    }

    return {
      page: Number(pg),
      pagecount: subType === 'classic_movie' ? 1 : (list.length > 0 ? Number(pg) + 1 : Number(pg)),
      limit: 20,
      total: 999,
      list: list
    };
  } catch (error) {
    await OmniBox.log('error', `获取Netflix数据失败: ${error.message}`);
    return { page: Number(pg), pagecount: 1, limit: 20, total: 0, list: [] };
  }
}

/**
 * 获取视频详情
 */
async function getVodDetail(vodId) {
  try {
    const res = await request(`${jpConfig.host}/api/video/detailv2?id=${vodId}`);
    if (res.code !== 1 || !res.data) {
      return null;
    }

    const v = res.data;
    const pic = fixPicUrl(v.tvimg || v.thumbnail || v.path || '');

    // 处理演员表
    let actorStr = '';
    if (Array.isArray(v.actors)) {
      actorStr = v.actors.map(a => a.name || a).filter(Boolean).join(', ');
    }

    // 处理类型标签
    let typeName = '';
    if (Array.isArray(v.types)) {
      typeName = v.types.map(t => t.name || t).filter(Boolean).join(' / ');
    }

    // 构建播放线路 (vod_play_sources)
    const playSources = [];
    if (Array.isArray(v.source_list_source)) {
      for (const source of v.source_list_source) {
        const sourceName = source.name || '未知线路';

        // 过滤无效/屏蔽线路
        if (shouldBlockSource(sourceName)) {
          await OmniBox.log('info', `已过滤屏蔽线路: ${sourceName}`);
          continue;
        }

        const episodes = [];
        if (Array.isArray(source.source_list)) {
          for (const ep of source.source_list) {
            const epName = ep.source_name || ep.weight || '正片';
            const epUrl = ep.url || '';

            if (shouldBlockUrl(epUrl)) {
              continue;
            }

            // 构造剧集播放ID，携带弹幕匹配所需的元数据
            const playMeta = {
              url: epUrl,
              title: v.title || '',
              epName: epName,
              vodId: String(v.id || vodId),
              pic: pic
            };

            episodes.push({
              name: epName,
              playId: JSON.stringify(playMeta)
            });
          }
        }

        if (episodes.length > 0) {
          playSources.push({
            name: sourceName,
            episodes: episodes
          });
        }
      }
    }

    return {
      vod_id: String(v.id || vodId),
      vod_name: v.title || '未知标题',
      vod_pic: pic,
      vod_remarks: v.mask || '',
      vod_year: v.year ? String(v.year) : '',
      vod_area: v.area || '',
      vod_actor: actorStr,
      vod_director: v.director || '',
      vod_content: v.description || '',
      type_name: typeName,
      vod_play_sources: playSources
    };
  } catch (error) {
    await OmniBox.log('error', `获取详情失败 [${vodId}]: ${error.message}`);
    return null;
  }
}

/**
 * 搜索视频
 */
async function searchVod(wd, pg = 1) {
  try {
    const params = new URLSearchParams();
    params.append('key', wd);
    params.append('page', String(pg));
    const res = await request(`${jpConfig.host}/api/v2/search/videoV2?${params.toString()}`);

    let list = [];
    if (res.code === 1 && Array.isArray(res.data)) {
      list = res.data.map(parseVodItem);
    }

    return {
      page: Number(pg),
      pagecount: list.length >= 10 ? Number(pg) + 1 : Number(pg),
      limit: 20,
      total: 999,
      list: list
    };
  } catch (error) {
    await OmniBox.log('error', `搜索失败 [${wd}]: ${error.message}`);
    return { page: Number(pg), pagecount: 1, limit: 20, total: 0, list: [] };
  }
}

/**
 * 匹配弹幕
 */
async function matchDanmaku(title, epName) {
  try {
    const fileName = epName && epName !== '正片' && epName !== '全集'
      ? `${title} ${epName}`
      : title;
    const danmakuList = await OmniBox.getDanmakuByFileName(fileName);
    if (danmakuList && danmakuList.length > 0) {
      await OmniBox.log('info', `匹配到弹幕 ${danmakuList.length} 条 [${fileName}]`);
      return danmakuList;
    }
  } catch (e) {
    await OmniBox.log('warn', `匹配弹幕失败: ${e.message}`);
  }
  return [];
}

/**
 * 处理播放请求
 */
async function handlePlay(playId, flag, params = {}) {
  try {
    let playUrl = playId;
    let title = '';
    let epName = '';
    let vodId = '';
    let pic = '';

    // 尝试解析 JSON 元数据
    try {
      const meta = JSON.parse(playId);
      if (meta && meta.url) {
        playUrl = meta.url;
        title = meta.title || '';
        epName = meta.epName || '';
        vodId = meta.vodId || '';
        pic = meta.pic || '';
      }
    } catch (e) {
      // 纯URL字符串兼容处理
    }

    await OmniBox.log('info', `解析播放地址: ${playUrl} (线路: ${flag || '默认'})`);

    // 异步记录播放历史
    if (vodId && title) {
      try {
        await OmniBox.addPlayHistory({
          vodId: vodId,
          title: title,
          pic: pic,
          episode: playId,
          episodeName: epName,
          sourceId: params.sourceId
        });
      } catch (e) {
        await OmniBox.log('warn', `写入播放历史失败: ${e.message}`);
      }
    }

    // 尝试匹配弹幕
    const danmaku = title ? await matchDanmaku(title, epName) : [];

    // 确定播放类型与请求头
    const lowerUrl = String(playUrl).toLowerCase();
    const isDirectVideo = lowerUrl.includes('.m3u8') || lowerUrl.includes('.mp4') || lowerUrl.includes('.flv') || lowerUrl.includes('index.m3u8');

    if (isDirectVideo) {
      return {
        parse: 0,
        urls: [
          {
            name: epName || flag || '播放',
            url: playUrl
          }
        ],
        header: {
          'User-Agent': jpConfig.headers['User-Agent'],
          'Referer': `${jpConfig.host}/`
        },
        danmaku: danmaku
      };
    }

    // 非直链时尝试嗅探解析
    return {
      parse: 1,
      urls: [
        {
          name: epName || flag || '播放',
          url: playUrl
        }
      ],
      header: {
        'User-Agent': jpConfig.headers['User-Agent'],
        'Referer': `${jpConfig.host}/`
      },
      danmaku: danmaku
    };
  } catch (error) {
    await OmniBox.log('error', `播放解析异常: ${error.message}`);
    return {
      parse: 0,
      urls: [],
      error: error.message
    };
  }
}

// ==========================================
// OmniBox 标准接口实现
// ==========================================

/**
 * 首页数据
 */
async function home(params) {
  await OmniBox.log('info', '正在获取荐片APP首页数据...');
  return await getHomeContent();
}

/**
 * 分类列表
 */
async function category(params) {
  const tid = params.categoryId || params.tid || '1';
  const pg = params.page || 1;
  const extend = params.filters || params.extend || {};
  await OmniBox.log('info', `正在获取分类列表: tid=${tid}, page=${pg}, filters=${JSON.stringify(extend)}`);
  return await getCategoryList(tid, pg, extend);
}

/**
 * 视频详情
 */
async function detail(params) {
  const vodId = params.videoId || params.id;
  if (!vodId) {
    return { list: [] };
  }
  await OmniBox.log('info', `正在获取视频详情: vodId=${vodId}`);
  const vod = await getVodDetail(vodId);
  return {
    list: vod ? [vod] : []
  };
}

/**
 * 搜索
 */
async function search(params) {
  const wd = params.keyword || params.wd || '';
  const pg = params.page || 1;
  if (!wd) {
    return { page: 1, pagecount: 1, limit: 20, total: 0, list: [] };
  }
  await OmniBox.log('info', `正在搜索: keyword=${wd}, page=${pg}`);
  return await searchVod(wd, pg);
}

/**
 * 播放
 */
async function play(params) {
  const playId = params.playId || params.id || '';
  const flag = params.flag || '';
  await OmniBox.log('info', `正在请求播放: flag=${flag}, playId=${playId}`);
  return await handlePlay(playId, flag, params);
}

module.exports = {
  home,
  category,
  detail,
  search,
  play
};

// 注册标准 runner
const runner = require("omnibox_sdk/runner");
runner.run(module.exports);
