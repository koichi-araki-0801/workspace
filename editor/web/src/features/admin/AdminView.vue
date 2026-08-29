<script setup lang="ts">
// =============================================================================
// AdminView.vue — ユーザー管理画面(追加・無効化/有効化・パスワード初期化)
// =============================================================================
import { canDisableUser, isErr, isOk, type User, type UserRole, validateNewUser } from '@editor/shared';
import { Ban, CircleCheck, Copy, KeyRound, Shield, UserPlus, X } from '@lucide/vue';
import { computed, onMounted, reactive, ref } from 'vue';
import { useUserRepo } from '@/api/repositories';
import BackButton from '@/components/ui/BackButton.vue';
import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import Card from '@/components/ui/Card.vue';
import { confirm } from '@/components/ui/confirm';
import FormField from '@/components/ui/FormField.vue';
import Input from '@/components/ui/Input.vue';
import Label from '@/components/ui/Label.vue';
import Select from '@/components/ui/Select.vue';
import TableContainer from '@/components/ui/TableContainer.vue';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, tableMessageCell } from '@/components/ui/table';
import { toastError, toastSuccess } from '@/components/ui/toast';
import { ROLE_LABELS } from '@/lib/labels';
import { useAsyncResult } from '@/lib/useAsyncResult';
import { useAuthStore } from '@/stores/auth';
import { toUserVm } from './viewmodels/userVm';

const repo = useUserRepo();
const auth = useAuthStore();
const { run } = useAsyncResult();
const rows = ref<User[]>([]);
const vms = computed(() => rows.value.map(toUserVm));
const roleOptions = (Object.keys(ROLE_LABELS) as UserRole[]).map((value) => ({
  value,
  label: ROLE_LABELS[value],
}));
const form = reactive({ username: '', displayName: '', role: 'editor' as UserRole });
// 追加処理の進行中。連打すると同じ入力で 2 人分作られ、後着の一時パスワードだけが残る。
const adding = ref(false);
const errors = reactive<{ username?: string; displayName?: string }>({});

/**
 * 払い出した一時パスワードの一時表示。サーバは平文を保存しないので、この画面を閉じる/
 * 再読み込みすると二度と取得できない(必要なら再度「パスワード初期化」で払い直す)。
 */
const issued = ref<{ label: string; username: string; password: string } | null>(null);

async function copyIssued() {
  if (!issued.value) return;
  try {
    await navigator.clipboard.writeText(issued.value.password);
    toastSuccess('一時パスワードをコピーしました');
  } catch {
    // 権限拒否や非セキュアコンテキストでは API が使えない。手入力できるよう画面には残す。
    toastError('コピーできませんでした。表示されている値を手で控えてください');
  }
}

async function load() {
  const res = await run(() => repo.listUsers());
  if (isOk(res)) rows.value = res.value;
}
onMounted(load);

function validate(): boolean {
  const result = validateNewUser(form, rows.value.map((u) => u.username));
  errors.username = result.username;
  errors.displayName = result.displayName;
  return !result.username && !result.displayName;
}

async function addUser() {
  if (adding.value || !validate()) return;
  adding.value = true;
  try {
    // 仮パスワード運用: 新規ユーザーは有効状態で作成し、初回ログイン時のパスワード再設定を必須にする。
    const res = await run(() =>
      repo.createUser({ ...form, disabled: false, mustChangePassword: true }),
    );
    if (isErr(res)) return;
    issued.value = {
      label: `${form.displayName} を追加しました`,
      username: form.username,
      password: res.value.temporaryPassword,
    };
    toastSuccess(`${form.displayName} を追加しました。一時パスワードを本人へお渡しください。`);
    form.username = '';
    form.displayName = '';
    await load();
  } finally {
    adding.value = false;
  }
}

async function toggleDisabled(u: User) {
  const disabling = !u.disabled;
  // 無効化方向のみガード: 自分自身・最後の有効 admin の無効化は永久ロックアウトを招くため拒否する。
  if (disabling) {
    const check = canDisableUser(u, auth.user?.id ?? '', rows.value);
    if (!check.ok) {
      toastError(check.reason ?? 'このユーザーは無効化できません');
      return;
    }
  }
  const ok = await confirm({
    title: disabling ? `${u.displayName} を無効化しますか？` : `${u.displayName} を有効化しますか？`,
    description: disabling
      ? '無効化するとこのユーザーはログインできなくなります。'
      : 'このユーザーは再びログインできるようになります。',
    confirmLabel: disabling ? '無効化する' : '有効化する',
    variant: disabling ? 'destructive' : 'default',
  });
  if (!ok) return;
  const res = await run(() => repo.updateUser(u.id, { disabled: disabling }));
  if (isErr(res)) return;
  toastSuccess(disabling ? `${u.displayName} を無効化しました` : `${u.displayName} を有効化しました`);
  await load();
}

async function resetPw(u: User) {
  const ok = await confirm({
    title: `${u.displayName} のパスワードを初期化しますか？`,
    description: '現在のパスワードは無効になり、次回ログイン時に再設定が必要になります。',
    confirmLabel: '初期化する',
    variant: 'destructive',
  });
  if (!ok) return;
  const res = await run(() => repo.resetUserPassword(u.id));
  if (isErr(res)) return;
  issued.value = {
    label: `${u.displayName} のパスワードを初期化しました`,
    username: u.username,
    password: res.value.temporaryPassword,
  };
  toastSuccess(`${u.displayName} のパスワードを初期化しました。一時パスワードを本人へお渡しください。`);
  await load();
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-3">
      <BackButton :fallback="{ name: 'edit' }" label="ホーム" />
      <div class="flex items-center gap-2 font-bold">
        <Shield class="h-[18px] w-[18px] text-primary" />
        <span class="text-[15px]">ユーザー管理</span>
      </div>
    </div>

    <!-- 一時パスワードは払い出し直後のこの 1 回しか表示できない(サーバは平文を保持しない)。 -->
    <Card v-if="issued" class="border-warning/40 bg-warning/10 p-4">
      <div class="flex flex-wrap items-center gap-3">
        <KeyRound class="h-[18px] w-[18px] text-warning-foreground" />
        <div class="text-sm font-semibold">{{ issued.label }}</div>
        <div class="text-sm">
          ユーザーID <span class="mono font-semibold">{{ issued.username }}</span> の一時パスワード:
          <span class="mono select-all rounded border bg-background px-2 py-1 font-semibold">
            {{ issued.password }}
          </span>
        </div>
        <Button size="sm" variant="outline" @click="copyIssued">
          <Copy class="h-4 w-4" /> コピー
        </Button>
        <Button size="sm" variant="ghost" aria-label="閉じる" @click="issued = null">
          <X class="h-4 w-4" />
        </Button>
      </div>
      <p class="mt-2 text-xs text-muted-foreground">
        この値は再表示できません。本人へ口頭・書面で渡し、初回ログイン時に必ず変更させてください。
      </p>
    </Card>

    <Card class="p-4">
      <h3 class="mb-3 text-sm font-semibold">ユーザー追加</h3>
      <div class="flex flex-wrap items-start gap-3">
        <FormField>
          <Label for="new-username">ユーザーID <span class="text-destructive">*</span></Label>
          <Input
            id="new-username"
            v-model="form.username"
            placeholder="taro"
            :aria-invalid="!!errors.username"
            @input="errors.username = undefined"
          />
          <p v-if="errors.username" class="text-xs text-destructive">{{ errors.username }}</p>
        </FormField>
        <FormField>
          <Label for="new-displayname">表示名 <span class="text-destructive">*</span></Label>
          <Input
            id="new-displayname"
            v-model="form.displayName"
            placeholder="山田太郎"
            :aria-invalid="!!errors.displayName"
            @input="errors.displayName = undefined"
          />
          <p v-if="errors.displayName" class="text-xs text-destructive">{{ errors.displayName }}</p>
        </FormField>
        <FormField width="xs" :grow="false">
          <Label for="new-role">権限</Label>
          <Select v-model="form.role" :options="roleOptions" />
        </FormField>
        <Button class="mt-6" :disabled="adding" @click="addUser"><UserPlus class="h-4 w-4" /> 追加</Button>
      </div>
    </Card>

    <TableContainer>
      <Table class="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead class="w-[160px]">ユーザーID</TableHead><TableHead>表示名</TableHead><TableHead class="w-[120px] text-center">権限</TableHead>
            <TableHead class="w-[160px] text-center">状態</TableHead><TableHead class="w-[300px] text-center">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody class="[&>tr:nth-child(even)]:bg-muted/40">
          <TableRow v-for="vm in vms" :key="vm.id">
            <TableCell class="mono truncate">{{ vm.username }}</TableCell>
            <TableCell class="truncate font-semibold">{{ vm.displayName }}</TableCell>
            <TableCell class="text-center"><Badge variant="outline">{{ vm.roleLabel }}</Badge></TableCell>
            <TableCell class="text-center">
              <Badge :variant="vm.statusVariant">{{ vm.statusLabel }}</Badge>
              <Badge v-if="vm.needsPasswordReset" variant="warning" class="ml-1">要再設定</Badge>
            </TableCell>
            <TableCell class="space-x-2 text-center">
              <Button size="sm" variant="outline" @click="resetPw(vm.raw)"><KeyRound class="h-4 w-4" /> パスワード初期化</Button>
              <Button
                size="sm"
                variant="outline"
                :class="vm.raw.disabled ? '' : 'text-destructive hover:text-destructive'"
                @click="toggleDisabled(vm.raw)"
              >
                <CircleCheck v-if="vm.raw.disabled" class="h-4 w-4" />
                <Ban v-else class="h-4 w-4" />
                {{ vm.raw.disabled ? '有効化' : '無効化' }}
              </Button>
            </TableCell>
          </TableRow>
          <TableRow v-if="vms.length === 0">
            <TableCell colspan="5" :class="tableMessageCell()">
              ユーザーがいません
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </TableContainer>
  </div>
</template>
