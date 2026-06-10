<script setup lang="ts">
import { isErr, isOk, type User, type UserRole, validateNewUser } from '@editor/shared';
import { Ban, CircleCheck, KeyRound, UserPlus } from '@lucide/vue';
import { computed, onMounted, reactive, ref } from 'vue';
import BackButton from '@/components/ui/BackButton.vue';
import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import Card from '@/components/ui/Card.vue';
import { confirm } from '@/components/ui/confirm';
import Input from '@/components/ui/Input.vue';
import Label from '@/components/ui/Label.vue';
import Select from '@/components/ui/Select.vue';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toastSuccess } from '@/components/ui/toast';
import { ROLE_LABELS } from '@/lib/labels';
import { useAsyncResult } from '@/lib/useAsyncResult';
import { useUserService } from './services/userService';
import { toUserVm } from './viewmodels/userVm';

const users = useUserService();
const { run } = useAsyncResult();
const rows = ref<User[]>([]);
const vms = computed(() => rows.value.map(toUserVm));
const roleOptions = (Object.keys(ROLE_LABELS) as UserRole[]).map((value) => ({
  value,
  label: ROLE_LABELS[value],
}));
const form = reactive({ username: '', displayName: '', role: 'editor' as UserRole });
const errors = reactive<{ username?: string; displayName?: string }>({});

async function load() {
  const res = await run(() => users.list());
  if (isOk(res)) rows.value = res.value;
}
onMounted(load);

function validate(): boolean {
  const result = validateNewUser(form);
  errors.username = result.username;
  errors.displayName = result.displayName;
  return !result.username && !result.displayName;
}

async function addUser() {
  if (!validate()) return;
  const res = await run(() => users.add({ ...form }));
  if (isErr(res)) return;
  toastSuccess(`${form.displayName} を追加しました。初期パスワードを発行済みです。`);
  form.username = '';
  form.displayName = '';
  await load();
}

async function toggleDisabled(u: User) {
  const disabling = !u.disabled;
  const ok = await confirm({
    title: disabling ? `${u.displayName} を無効化しますか？` : `${u.displayName} を有効化しますか？`,
    description: disabling
      ? '無効化するとこのユーザーはログインできなくなります。'
      : 'このユーザーは再びログインできるようになります。',
    confirmLabel: disabling ? '無効化する' : '有効化する',
    variant: disabling ? 'destructive' : 'default',
  });
  if (!ok) return;
  const res = await run(() => users.setDisabled(u.id, disabling));
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
  const res = await run(() => users.resetPassword(u.id));
  if (isErr(res)) return;
  toastSuccess(`${u.displayName} のパスワードを初期化しました`);
  await load();
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-3">
      <BackButton :fallback="{ name: 'edit' }" label="ホーム" />
      <h2 class="text-lg font-semibold">ユーザー管理</h2>
    </div>

    <Card class="p-4">
      <h3 class="mb-3 text-sm font-semibold">ユーザー追加</h3>
      <div class="flex flex-wrap items-start gap-3">
        <div class="space-y-1.5">
          <Label for="new-username">ユーザーID <span class="text-destructive">*</span></Label>
          <Input
            id="new-username"
            v-model="form.username"
            placeholder="taro"
            :aria-invalid="!!errors.username"
            @input="errors.username = undefined"
          />
          <p v-if="errors.username" class="text-xs text-destructive">{{ errors.username }}</p>
        </div>
        <div class="space-y-1.5">
          <Label for="new-displayname">表示名 <span class="text-destructive">*</span></Label>
          <Input
            id="new-displayname"
            v-model="form.displayName"
            placeholder="山田太郎"
            :aria-invalid="!!errors.displayName"
            @input="errors.displayName = undefined"
          />
          <p v-if="errors.displayName" class="text-xs text-destructive">{{ errors.displayName }}</p>
        </div>
        <div class="min-w-[140px] space-y-1.5">
          <Label for="new-role">権限</Label>
          <Select v-model="form.role" :options="roleOptions" />
        </div>
        <Button class="mt-6" @click="addUser"><UserPlus class="h-4 w-4" /> 追加</Button>
      </div>
    </Card>

    <div class="overflow-hidden rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>ユーザーID</TableHead><TableHead>表示名</TableHead><TableHead>権限</TableHead>
            <TableHead>状態</TableHead><TableHead class="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="vm in vms" :key="vm.id">
            <TableCell class="font-medium">{{ vm.username }}</TableCell>
            <TableCell>{{ vm.displayName }}</TableCell>
            <TableCell><Badge variant="outline">{{ vm.roleLabel }}</Badge></TableCell>
            <TableCell>
              <Badge :variant="vm.statusVariant">{{ vm.statusLabel }}</Badge>
              <Badge v-if="vm.needsPasswordReset" variant="warning" class="ml-1">要再設定</Badge>
            </TableCell>
            <TableCell class="space-x-2 text-right">
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
            <TableCell colspan="5" class="py-8 text-center text-muted-foreground">
              ユーザーがいません
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  </div>
</template>
