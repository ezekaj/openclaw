const formatAllowFrom = (params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId?: string | null;
  allowFrom: Array<string | number>;
}) => {
  if (params.plugin.config.formatAllowFrom) {
    return params.plugin.config.formatAllowFrom({
      cfg: params.cfg,
      accountId: params.accountId,
      allowFrom: params.allowFrom ?? [],
    });
  }
  return (params.allowFrom ?? [])
    .map((entry) => String(entry).trim());
};