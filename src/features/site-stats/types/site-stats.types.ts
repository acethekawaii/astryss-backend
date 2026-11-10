export type ManilaDate = string & { readonly __brand: 'ManilaDate' };
export type VisitorHash = string & { readonly __brand: 'VisitorHash' };

export type VisitSummary = {
  totalPageviews: number;
  todayPageviews: number;
  todayVisitors: number;
  since: string | null;
};
