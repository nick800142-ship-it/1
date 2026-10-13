import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
type UserProfile = {
  id: string;
  email: string;
  display_name: string | null;
  nickname: string | null;
  agency_role: string | null;
  role: string | null;
  referrer_id: string | null;
  parent_id: string | null;
  created_at: string;
};

type UserListProps = {
  onSelectUser: (userId: string) => void;
};

export function UserList({ onSelectUser }: UserListProps) {
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    let active = true;

    async function loadUsers() {
      setLoading(true);
      setErrorMessage("");

      const { data, error } = await supabase.rpc(
        "get_all_agent_performance_members",
      );

      const members = Array.isArray(data)
        ? data
        : data && typeof data === "object" && "members" in data
          ? (data as { members: unknown }).members
          : [];

      if (!active) return;

      if (error) {
        setErrorMessage("無法載入用戶列表，請稍後再試。");
        setLoading(false);
        return;
      }

      const uniqueMembers = new Map(
        (members as UserProfile[])
          .filter((member) => member?.id)
          .map((member) => [member.id, member]),
      );
      setUsers(Array.from(uniqueMembers.values()));
      setLoading(false);
    }

    void loadUsers();

    return () => {
      active = false;
    };
  }, []);

  const filteredUsers = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();

    if (!keyword) return users;

    return users.filter((user) =>
      [
        user.email,
        user.nickname,
        user.display_name,
        user.referrer_id,
        user.parent_id,
      ].some((value) =>
        String(value ?? "")
          .toLocaleLowerCase()
          .includes(keyword),
      ),
    );
  }, [query, users]);

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-bold text-slate-100">用戶列表</h2>
        <p className="text-sm leading-6 text-slate-400">
          選擇用戶後前往詳細紀錄頁，列表不會直接顯示交易明細。
        </p>
      </header>

      <label className="mt-5 block">
        <span className="sr-only">搜尋用戶</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜尋 Email、名稱或身分"
          className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-amber-400"
        />
      </label>

      {loading && <p className="mt-5 text-sm text-slate-400">正在載入用戶…</p>}

      {errorMessage && (
        <p role="alert" className="mt-5 text-sm text-rose-300">
          {errorMessage}
        </p>
      )}

      {!loading && !errorMessage && (
        <div className="mt-5 flex flex-col gap-2">
          {filteredUsers.map((user) => {
            const name = user.nickname || user.display_name || user.email;
            const parentId = user.referrer_id || user.parent_id;
            const parent = users.find((candidate) => candidate.id === parentId);
            const level = !parentId || !parent
              ? "L0"
              : parent.referrer_id || parent.parent_id
                ? "L2"
                : "L1";

            return (
              <button
                key={user.id}
                type="button"
                onClick={() => onSelectUser(user.id)}
                className="flex w-full flex-col gap-3 rounded-xl bg-slate-950 p-4 text-left transition hover:bg-slate-800 sm:flex-row sm:items-center sm:justify-between"
                aria-label={`查看 ${name} 的詳細紀錄`}
              >
                <span className="min-w-0">
                  <b className="block break-all text-sm text-slate-200">
                    {name}
                  </b>
                  <span className="mt-1 block break-all text-xs text-slate-500">
                    {user.email}
                  </span>
                </span>

                <span className="flex items-center justify-between gap-3 sm:shrink-0">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-sky-400/10 px-3 py-1 text-xs font-semibold text-sky-300">
                      {level}
                    </span>
                  </span>
                  <span aria-hidden="true" className="text-amber-300">
                    查看
                  </span>
                </span>
              </button>
            );
          })}

          {!filteredUsers.length && (
            <p className="rounded-xl bg-slate-950 p-5 text-center text-sm text-slate-500">
              找不到符合條件的用戶。
            </p>
          )}
        </div>
      )}
    </section>
  );
}
